# AutoADB Node

AutoADB Node keeps watching for Android devices that expose wireless ADB and lets you connect or pair instantly when they show up.

## Features

- **Auto-discovery**: Automatically discovers Android devices on your network advertising wireless ADB
- **Fail-proof connections**: Automatic retry with exponential backoff and connection verification
- **Smart device tracking**: Tracks device states and prevents repeated connection attempts to problematic devices
- **Optimized scrcpy**: Launches scrcpy with `-m 1024` for faster streaming and `--no-audio` to prevent errors
- **Background mode**: Run headless with desktop notifications and auto-connect

## Usage

```bash
# install dependencies
npm install

# run interactively (default)
npx autoadb-node

# run headless with desktop notifications and auto-connect (recommended for PM2)
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"
nohup npx autoadb-node --notify --auto-connect --no-interactive > /tmp/autoadb.log 2>&1 &
```

### Flags

- `--notify`: send desktop notifications (`notify-send` on Ubuntu)
- `--auto-connect`: connect automatically when a device appears
- `--no-interactive`: skip prompts; suitable for background runs

### PM2 Integration

For persistent background operation:

```bash
pm2 start "npx autoadb-node --notify --auto-connect --no-interactive" --name autoadb
pm2 save
pm2 startup
```

## Troubleshooting

If you encounter `EPERM` / `EACCES` binding to UDP 5353, run the `setcap` command above once or execute the script with elevated permissions.

### Common Issues

- **Connection failures**: The tool automatically retries up to 3 times with exponential backoff
- **AudioRecord errors**: Audio is now disabled by default (`--no-audio` flag for scrcpy)
- **Device disconnects**: Devices with repeated failures are temporarily blocked for 5 minutes
- **Stale connections**: Old connections are automatically cleaned up every 10 minutes
