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

browser.on("up", (service) => {
  const device = normalizeService(service);
  if (!device.endpoint) {
    return;
  }

  const existing = devices.get(device.key);
  devices.set(device.key, device);

  if (existing && existing.endpoint === device.endpoint) {
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
    console.error("Interaction error:", error);
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

async function connectDevice(device) {
  console.log(`Connecting to ${device.name} (${device.endpoint})...`);
  try {
    await runAdb(["disconnect", device.endpoint]).catch(() => {});
    await runAdb(["connect", device.endpoint]);
    console.log(`Connected to ${device.name}!`);
    sendNotification("ADB connected", `${device.name} @ ${device.endpoint}`);
    launchScrcpy(device.endpoint);
  } catch (error) {
    console.error(`Failed to connect: ${error.message}`);
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

function runAdb(args) {
  return new Promise((resolve, reject) => {
    execFile("adb", args, { windowsHide: true }, (error, stdout, stderr) => {
      if (stderr) {
        process.stderr.write(stderr);
      }
      if (stdout) {
        process.stdout.write(stdout);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
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

function launchScrcpy(endpoint) {
  console.log(`Launching scrcpy for ${endpoint}...`);
  const child = spawn("scrcpy", [`--tcpip=${endpoint}`, "-m", "1024"], {
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("error", (error) => {
    console.error(`Failed to start scrcpy: ${error.message}`);
  });
}
