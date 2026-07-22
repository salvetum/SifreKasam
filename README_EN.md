<div align="center">

<img src="favicon.ico" width="128" height="128" alt="ŞifreKasam Logo">

# ŞifreKasam

**A local and open-source desktop password manager**

Keep your data on your device and protect it using a master password.

<br>

[![Türkçe](https://img.shields.io/badge/README-Türkçe-1f6feb?style=for-the-badge)](README.md)
[![English](https://img.shields.io/badge/README-English-1f6feb?style=for-the-badge)](README_EN.md)

<br>

[![Latest Release](https://img.shields.io/github/v/release/salvetum/SifreKasam?style=flat-square&label=Latest%20Release)](https://github.com/salvetum/SifreKasam/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/salvetum/SifreKasam/total?style=flat-square&label=Downloads)](https://github.com/salvetum/SifreKasam/releases)
[![License](https://img.shields.io/github/license/salvetum/SifreKasam?style=flat-square&label=License)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square)](https://github.com/salvetum/SifreKasam/releases/latest)

<br>

[⬇️ Download Latest Release](https://github.com/salvetum/SifreKasam/releases/latest)
&nbsp;•&nbsp;
[🐛 Report a Bug](https://github.com/salvetum/SifreKasam/issues)
&nbsp;•&nbsp;
[📜 THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

</div>

---

## What is ŞifreKasam?

**ŞifreKasam** is a locally running desktop password manager. Your data is stored on your device and encrypted using a master password. The application is distributed as an Electron and Flask-based desktop package.

> This project was initially created to experiment with AI-assisted development and *vibe coding*.

## 📸 Screenshots

<div align="center">

### Main Page

<img src="assets/base.png" width="850" alt="ŞifreKasam main page">

<br><br>

<table>
  <tr>
    <td align="center" width="50%">
      <strong>Password Generator</strong>
      <br><br>
      <img src="assets/passgen.png" width="420" alt="ŞifreKasam password generator screen">
    </td>
    <td align="center" width="50%">
      <strong>Settings Menu</strong>
      <br><br>
      <img src="assets/settings.gif" width="420" alt="ŞifreKasam settings menu">
    </td>
  </tr>
</table>

</div>

## Download Source and Security Warning

Official and trusted distributions of this software are published only through the following repository:

**https://github.com/salvetum/SifreKasam**

The security, integrity, and freshness of files downloaded from third-party websites, file-sharing platforms, reuploaded packages, or modified versions cannot be guaranteed.

The project developer is not responsible for data loss, malware, account security issues, system failures, or other damage caused by versions downloaded from unofficial sources.

Before downloading, make sure the address belongs to the official GitHub repository.

## Features

- Local database protected with master-password encryption
- Add, edit, delete, and favorite records
- Password generator and password health screen
- Turkish and English language support
- Dark and light themes
- Glass effects, accent colors, and background customization
- Import and export support
- Continue running in the system tray
- Automatic locking options
- Version checking through GitHub
> NOTE: No new features **will be added**. However, changes or bug fixes **may still be made**.

## Security Notes

> [!WARNING]
> This project was developed primarily for personal use and has not undergone an independent security audit.

- It is not recommended for commercial or high-risk use without an independent security review.
- If you forget your master password, recovering encrypted records may not be possible.
- LAN access is intended for development and convenient local connections.
- Keep LAN access disabled on networks you do not trust.
- Do not upload real databases, backups, certificates, private keys, or personal record files to the repository.

## Development

### Requirements

- Node.js
- npm
- Python
- PyInstaller

### Clone the Repository

```bash
git clone https://github.com/salvetum/SifreKasam.git
cd SifreKasam
```

### Install Dependencies

```bash
npm install
```

### Start the Development Version

```bash
npm start
```

### Create a Windows Package

```bash
npm run package
```

### Package the Flask Backend

Run the following commands inside the `flask_app` directory:

```bash
cd flask_app
pyinstaller app.spec --clean -y
```

## Files Excluded from the Repository

The following files and directories are intentionally excluded from Git:

```text
node_modules/
backend/
out/
flask_app/build/
flask_app/dist/
flask_app/*.db
```

Certificates, private keys, backups, temporary files, and personal data are also excluded.

## License

This project is released under the **MIT License**.

See the [`LICENSE`](LICENSE) file for details.

---

<div align="center">

ŞifreKasam is developed as an open-source project.

⭐ Consider starring the repository if you find it useful.

</div>
