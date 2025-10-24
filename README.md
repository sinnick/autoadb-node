# AutoADB Node

AutoADB Node keeps watching for Android devices that expose wireless ADB and lets you connect or pair instantly when they show up.

## Usage

```bash
# install dependencies
npm install

# run interactively (default)
npx autoadb-node

# run headless with desktop notifications and auto-connect
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"
nohup npx autoadb-node --notify --auto-connect --no-interactive > /tmp/autoadb.log 2>&1 &
```

Flags:
- `--notify`: send desktop notifications (`notify-send` on Ubuntu).
- `--auto-connect`: connect automatically when a device appears.
- `--no-interactive`: skip prompts; suitable for background runs.

If you encounter `EPERM` / `EACCES` binding to UDP 5353, run the `setcap` command above once or execute the script with elevated permissions.
