#!/usr/bin/env node

const { execFile, spawn } = require("child_process");
const readline = require("readline");
const { Bonjour } = require("bonjour-service");

const CONNECT_SERVICE = { type: "adb-tls-connect", protocol: "tcp" };
const PAIRING_SERVICE = { type: "adb-tls-pairing", protocol: "tcp" };
const BONJOUR_OPTIONS = { reuseAddr: true };

const args = new Set(process.argv.slice(2));
const useNotifications = args.has("--notify");
const autoConnect = args.has("--auto-connect");
const interactive = process.stdin.isTTY && !args.has("--no-interactive");

const rl = interactive
  ? readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
  : null;

const devices = new Map();
const deviceStates = new Map(); // Track device connection states
let interactionQueue = Promise.resolve();
let bonjourFatalErrorHandled = false;

console.log(
  interactive
    ? "Listening for Android devices advertising wireless ADB...\n" +
        "As soon as one shows up you'll be asked whether to connect or pair.\n" +
        "Press Ctrl+C to exit.\n"
    : "Listening for Android devices advertising wireless ADB in non-interactive mode...\n" +
        "Devices will be logged and, if --auto-connect is set, connected automatically.\n" +
        "Press Ctrl+C to exit.\n"
);

const bonjour = createBonjourInstance();
const browser = bonjour.find(CONNECT_SERVICE);

// Cleanup stale device states every 10 minutes
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 600000; // 10 minutes
  for (const [key, state] of deviceStates.entries()) {
    if (now - state.lastSeen > staleThreshold) {
      console.log(`\n[~] Cleaning up stale device state: ${key}`);
      deviceStates.delete(key);
    }
  }
}, 600000);

browser.on("up", (service) => {
  const device = normalizeService(service);
  if (!device.endpoint) {
    return;
  }

  const existing = devices.get(device.key);
  const state = deviceStates.get(device.key) || { lastSeen: 0, failCount: 0 };
  const now = Date.now();

  // Check if we should skip this announcement
  if (existing && existing.endpoint === device.endpoint && now - state.lastSeen < 5000) {
    // Device re-announced but endpoint is same and was recently seen, skip
    return;
  }

  devices.set(device.key, device);
  state.lastSeen = now;
  deviceStates.set(device.key, state);

  // Skip devices that have failed too many times recently
  if (state.failCount > 5 && Date.now() - state.lastFailTime < 300000) {
    console.log(`\n[!] Ignoring ${device.name} due to repeated failures (will retry in ${Math.ceil((300000 - (Date.now() - state.lastFailTime)) / 60000)} min)`);
    return;
  }

  queueInteraction(async () => {
    console.log(`\n[+] Device detected: ${device.name} (${device.endpoint})`);
    sendNotification("ADB device detected", `${device.name} @ ${device.endpoint}`);

    if (!interactive) {
      if (autoConnect) {
        await connectDevice(device);
      } else {
        console.log("Running non-interactive; leaving device idle. Use `adb connect` manually.");
      }
      return;
    }

    const action = autoConnect
      ? "connect"
      : await askChoice("Connect now? [Y]es / [p]air / [s]kip: ", {
          default: "y",
          mapping: { y: "connect", p: "pair", s: "skip" },
        });

    if (action === "connect") {
      await connectDevice(device);
    } else if (action === "pair") {
      await pairDevice(device);
    } else {
      console.log("Skipping. I'll keep listening...");
    }
  });
});

browser.on("down", (service) => {
  const device = normalizeService(service);
  if (devices.delete(device.key)) {
    queueInteraction(async () => {
      console.log(`\n[-] Device offline: ${device.name}`);
    });
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("\nStopping listener...");
  browser.stop();
  bonjour.destroy();
  if (rl) {
    rl.close();
  }
  process.exit(0);
}

function queueInteraction(task) {
  interactionQueue = interactionQueue.then(() => task()).catch((error) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] Interaction error:`, error);
    if (error.stack) {
      console.error(error.stack);
    }
  });
}

function ask(question) {
  if (!rl) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askChoice(prompt, { default: defaultKey, mapping }) {
  if (!rl) {
    return mapping[defaultKey];
  }

  const validKeys = Object.keys(mapping);

  while (true) {
    const answer = (await ask(prompt)).trim().toLowerCase();
    if (!answer && defaultKey) {
      return mapping[defaultKey];
    }
    const key = answer[0];
    if (key && validKeys.includes(key)) {
      return mapping[key];
    }
    console.log(`Please pick one of: ${validKeys.join(", ")}.`);
  }
}

async function connectDevice(device, retryCount = 0) {
  const maxRetries = 3;
  const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 8000);
  const state = deviceStates.get(device.key) || { lastSeen: 0, failCount: 0 };

  console.log(`Connecting to ${device.name} (${device.endpoint})...${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);

  try {
    // First disconnect any stale connection
    await runAdb(["disconnect", device.endpoint]).catch(() => {});

    // Wait a bit before connecting
    await new Promise(resolve => setTimeout(resolve, 500));

    // Try to connect
    await runAdb(["connect", device.endpoint]);

    // Verify connection by checking device list
    const isConnected = await verifyDeviceConnection(device.endpoint);
    if (!isConnected) {
      throw new Error("Device connection verification failed");
    }

    console.log(`Connected to ${device.name}!`);
    sendNotification("ADB connected", `${device.name} @ ${device.endpoint}`);

    // Reset fail count on successful connection
    state.failCount = 0;
    deviceStates.set(device.key, state);

    // Wait a bit before launching scrcpy to ensure connection is stable
    await new Promise(resolve => setTimeout(resolve, 1000));
    launchScrcpy(device.endpoint);
  } catch (error) {
    console.error(`Failed to connect: ${error.message}`);

    if (retryCount < maxRetries) {
      console.log(`Retrying in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return connectDevice(device, retryCount + 1);
    }

    // Track failure
    state.failCount = (state.failCount || 0) + 1;
    state.lastFailTime = Date.now();
    deviceStates.set(device.key, state);

    console.error(`Max retries reached for ${device.name} (total failures: ${state.failCount})`);
    sendNotification("ADB connect failed", `${device.name}: ${error.message}`);
  }
}

async function pairDevice(device) {
  if (!interactive) {
    console.log("Cannot pair in non-interactive mode. Re-run in a terminal to pair.");
    return;
  }

  console.log(
    'Enable wireless debugging pairing on the device, then choose "Pair device with pairing code".'
  );

  const pairingBonjour = createBonjourInstance();
  const browser = pairingBonjour.find(PAIRING_SERVICE);

  await new Promise((resolve) => {
    const handleService = (service) => {
      if (!serviceMatches(device, service)) {
        return;
      }

      const endpoint = serviceEndpoint(service);
      if (!endpoint) {
        console.log("Seen pairing service without an IPv4 address. Retry pairing.");
        return;
      }

      queueInteraction(async () => {
        let code = "";
        while (!code) {
          const input = (await ask("Pairing code (6 digits): ")).trim();
          if (/^[0-9]{6}$/.test(input)) {
            code = input;
          } else {
            console.log("Invalid code, try again.");
          }
        }

        try {
          await runAdb(["pair", endpoint, code]);
          console.log(`Pairing with ${device.name} succeeded.`);
        } catch (error) {
          console.error(`Pairing failed: ${error.message}`);
        } finally {
          browser.removeListener("up", handleService);
          browser.stop();
          pairingBonjour.destroy();
          resolve();
        }
      });
    };

    browser.on("up", handleService);
  });
}

function createBonjourInstance() {
  const instance = new Bonjour(BONJOUR_OPTIONS);
  const mdns = instance && instance.server && instance.server.mdns;
  if (mdns && typeof mdns.on === "function") {
    mdns.on("error", handleBonjourError);
  }
  return instance;
}

function handleBonjourError(error) {
  if (!error) {
    return;
  }

  if (!bonjourFatalErrorHandled && (error.code === "EACCES" || error.code === "EPERM")) {
    bonjourFatalErrorHandled = true;
    console.error(
      "Failed to access mDNS (UDP 5353). Run with elevated permissions or grant Node.js\n" +
        "cap_net_bind_service (e.g. sudo setcap 'cap_net_bind_service=+ep' $(readlink -f \"$(which node)\"))"
    );
    process.exit(1);
    return;
  }

  if (!bonjourFatalErrorHandled) {
    bonjourFatalErrorHandled = true;
    console.error("Bonjour/mDNS error:", error);
    process.exit(1);
  }
}

function normalizeService(service) {
  const endpoint = serviceEndpoint(service);
  return {
    key: service.fqdn || `${service.name}:${endpoint}`,
    name: service.name || "Unnamed device",
    endpoint,
    addresses: service.addresses || [],
    port: service.port,
  };
}

function serviceEndpoint(service) {
  const ip = pickInetAddress(service);
  return ip ? `${ip}:${service.port}` : null;
}

function pickInetAddress(service) {
  if (Array.isArray(service.addresses)) {
    const ipv4 = service.addresses.find((addr) => /^[0-9.]+$/.test(addr));
    if (ipv4) {
      return ipv4;
    }
    if (service.addresses.length > 0) {
      return service.addresses[0];
    }
  }
  if (service.host && /^[0-9.]+$/.test(service.host)) {
    return service.host;
  }
  return null;
}

function serviceMatches(device, service) {
  const target = device.name.toLowerCase();
  const candidates = [service.name, service.fqdn]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  return candidates.some((value) => value.startsWith(target));
}

function runAdb(args, options = {}) {
  const { captureOutput = false, silent = false } = options;
  return new Promise((resolve, reject) => {
    execFile("adb", args, { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (stderr && !silent) {
        process.stderr.write(stderr);
      }
      if (stdout && !silent && !captureOutput) {
        process.stdout.write(stdout);
      }
      if (error) {
        reject(error);
      } else {
        resolve(captureOutput ? stdout : undefined);
      }
    });
  });
}

async function verifyDeviceConnection(endpoint) {
  try {
    const output = await runAdb(["devices"], { captureOutput: true, silent: true });
    const lines = output.split('\n').map(line => line.trim());
    const deviceLine = lines.find(line => line.startsWith(endpoint));
    return deviceLine && deviceLine.includes('device') && !deviceLine.includes('offline');
  } catch (error) {
    console.error(`Device verification failed: ${error.message}`);
    return false;
  }
}

function sendNotification(title, body) {
  if (!useNotifications) {
    return;
  }
  try {
    const child = spawn("notify-send", [title, body], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      console.error("notify-send not available; disable --notify or install libnotify-bin.");
    });
    child.unref();
  } catch (error) {
    console.error("Unable to send desktop notification:", error.message);
  }
}

function launchScrcpy(endpoint, retryCount = 0) {
  const maxRetries = 2;
  console.log(`Launching scrcpy for ${endpoint}...${retryCount > 0 ? ` (attempt ${retryCount + 1}/${maxRetries + 1})` : ''}`);

  const scrcpyArgs = [
    `--tcpip=${endpoint}`,
    "-m", "1024",           // Max resolution 1024 (faster)
    "--no-audio",           // Disable audio to prevent AudioRecord errors
    "--stay-awake"          // Keep device awake while connected
  ];

  const child = spawn("scrcpy", scrcpyArgs, {
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("error", (error) => {
    console.error(`Failed to start scrcpy: ${error.message}`);
    if (retryCount < maxRetries) {
      console.log(`Retrying scrcpy in 2 seconds...`);
      setTimeout(() => launchScrcpy(endpoint, retryCount + 1), 2000);
    }
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`scrcpy exited with code ${code}`);
      if (retryCount < maxRetries && code !== 1) {
        console.log(`Retrying scrcpy in 2 seconds...`);
        setTimeout(() => launchScrcpy(endpoint, retryCount + 1), 2000);
      }
    }
  });
}
