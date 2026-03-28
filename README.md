# Visual pdf mixer

Small application to visually combine different pdf documents.

You can download the installers from the [latest release](https://github.com/RubendeBruin/visual-pdf-mixer/releases/latest) or checkout the repository and build yourself.

<img width="860" height="701" alt="{FA0F0EED-2195-408A-91B5-12AB95B1A87F}" src="https://github.com/user-attachments/assets/c5a18e1e-6b50-4317-afd7-7a248a8ea765" />

This is application is vibe-coded using claude because I could not find a free, small and easy to use tool to do just this.

## Installation

### Interactive install

Double-click the `.msi` file to run the standard GUI installer.

### Silent / unattended install (Windows MSI)

The `.msi` package supports standard [Windows Installer command-line switches](https://learn.microsoft.com/en-us/windows/win32/msi/command-line-options), which allows fully automated, unattended deployments (e.g. via Group Policy, SCCM, or a CI pipeline).

**Silent install – no UI at all:**
```cmd
msiexec /i "PDF Mixer_x.x.x_x64_en-US.msi" /quiet /norestart
```

**Passive install – progress bar only, no prompts:**
```cmd
msiexec /i "PDF Mixer_x.x.x_x64_en-US.msi" /passive /norestart
```

**Silent install with a verbose log file** (useful for troubleshooting):
```cmd
msiexec /i "PDF Mixer_x.x.x_x64_en-US.msi" /quiet /norestart /l*v install.log
```

**Silent uninstall:**
```cmd
msiexec /x "PDF Mixer_x.x.x_x64_en-US.msi" /quiet /norestart
```

Replace `x.x.x` with the actual version number from the release (e.g. `0.1.0`).

| Switch | Effect |
|---|---|
| `/quiet` | No UI, no prompts. Runs completely silently. |
| `/passive` | Minimal UI (progress bar only). No user interaction required. |
| `/norestart` | Suppresses any automatic reboot after installation. |
| `/l*v <file>` | Writes a verbose log to `<file>` for troubleshooting. |
| `/x` | Uninstalls the package instead of installing it. |

