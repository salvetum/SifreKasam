# Third-Party Notices

ŞifreKasam includes or is built with third-party software and assets. Those
components remain subject to their own copyright notices and license terms.
The version information below reflects `package-lock.json`,
`flask_app/requirements.txt`, and the locally bundled static assets as of
2026-07-22.

This document is informational and does not replace the original license
texts. When redistributing ŞifreKasam, the corresponding third-party license
terms must also be followed.

## Electron Runtime

| Component | Version | License | Project |
| --- | ---: | --- | --- |
| Electron | 42.6.1 | MIT | <https://github.com/electron/electron> |
| Chromium, Node.js, V8, FFmpeg and other Electron runtime components | Bundled with Electron | Multiple open-source licenses | Included Electron distributions contain `LICENSE` and `LICENSES.chromium.html` with the complete notices. |

## Node.js Runtime Packages

| Component | Version | License | Project |
| --- | ---: | --- | --- |
| electron-squirrel-startup | 1.0.1 | Apache-2.0 | <https://www.npmjs.com/package/electron-squirrel-startup> |
| debug | 2.6.9 | MIT | <https://www.npmjs.com/package/debug> |
| ms | 2.0.0 | MIT | <https://www.npmjs.com/package/ms> |
| tree-kill | 1.2.2 | MIT | <https://www.npmjs.com/package/tree-kill> |

## Python Runtime Packages

| Component | Version | License | Project |
| --- | ---: | --- | --- |
| Flask | 3.1.3 | BSD-3-Clause | <https://github.com/pallets/flask> |
| blinker | 1.9.0 | MIT | <https://github.com/pallets-eco/blinker> |
| click | 8.4.2 | BSD-3-Clause | <https://github.com/pallets/click> |
| colorama | 0.4.6 | BSD-3-Clause | <https://github.com/tartley/colorama> |
| itsdangerous | 2.2.0 | BSD-3-Clause | <https://github.com/pallets/itsdangerous> |
| Jinja2 | 3.1.6 | BSD-3-Clause | <https://github.com/pallets/jinja> |
| MarkupSafe | 3.0.3 | BSD-3-Clause | <https://github.com/pallets/markupsafe> |
| Werkzeug | 3.1.8 | BSD-3-Clause | <https://github.com/pallets/werkzeug> |
| Flask-Login | 0.6.3 | MIT | <https://github.com/maxcountryman/flask-login> |
| Flask-SQLAlchemy | 3.1.1 | BSD-3-Clause | <https://github.com/pallets-eco/flask-sqlalchemy> |
| SQLAlchemy | 2.0.51 | MIT | <https://github.com/sqlalchemy/sqlalchemy> |
| greenlet | 3.5.3 | MIT AND PSF-2.0 | <https://github.com/python-greenlet/greenlet> |
| typing_extensions | 4.16.0 | PSF-2.0 | <https://github.com/python/typing_extensions> |
| cryptography | 48.0.1 | Apache-2.0 OR BSD-3-Clause | <https://github.com/pyca/cryptography> |
| cffi | 2.1.0 | MIT-0 | <https://github.com/python-cffi/cffi> |
| pycparser | 3.0 | BSD-3-Clause | <https://github.com/eliben/pycparser> |
| zxcvbn-python | 4.5.0 | MIT | <https://github.com/dwolfhub/zxcvbn-python> |

## Bundled UI Assets

| Component | Version | License | Notice / Project |
| --- | ---: | --- | --- |
| Bootstrap CSS | 5.3.8 | MIT | Copyright 2011-2025 The Bootstrap Authors. <https://github.com/twbs/bootstrap> |
| Font Awesome Free | 7.0.1 | Code: MIT; icons: CC BY 4.0; fonts: SIL OFL 1.1 | Copyright 2025 Fonticons, Inc. <https://fontawesome.com/license/free> |
| Sora typeface | Bundled webfont | SIL OFL 1.1 | <https://github.com/sora-xor/sora-font> |
| JetBrains Mono typeface | Bundled webfont | SIL OFL 1.1 | <https://github.com/JetBrains/JetBrainsMono> |

## Build-Time Tools

The following tools are used to produce distributable builds but are not
application source owned by ŞifreKasam.

| Component | Version | License | Project |
| --- | ---: | --- | --- |
| PyInstaller | 6.21.0 | GPL-2.0-or-later with the PyInstaller bootloader exception | <https://pyinstaller.org/en/stable/license.html> |
| Electron Forge CLI | 7.11.2 | MIT | <https://github.com/electron/forge> |
| Electron Forge Squirrel Maker | 7.11.2 | MIT | <https://github.com/electron/forge> |
| Electron Forge ZIP Maker | 7.11.2 | MIT | <https://github.com/electron/forge> |

## Font License Requiring Verification

The repository currently contains
`flask_app/static/fonts/Agrandir-GrandHeavy.otf`. Agrandir is a Pangram Pangram
Foundry typeface distributed under commercial / trial license terms; no
redistributable open-source license for this font file was found in the
repository.

Before publicly redistributing a build containing this file, the distributor
must verify that an appropriate license has been obtained and that embedding
and redistribution are permitted. If that cannot be verified, replace or
remove the font before the next public build.

Official product and licensing page:
<https://pangrampangram.com/products/agrandir-grand>

## Common License Texts

- MIT: <https://opensource.org/license/mit>
- BSD 3-Clause: <https://opensource.org/license/bsd-3-clause>
- Apache License 2.0: <https://www.apache.org/licenses/LICENSE-2.0>
- SIL Open Font License 1.1: <https://openfontlicense.org/open-font-license-official-text/>
- Creative Commons Attribution 4.0: <https://creativecommons.org/licenses/by/4.0/legalcode>
- Python Software Foundation License 2.0: <https://docs.python.org/3/license.html>
- MIT No Attribution: <https://opensource.org/license/mit-0>

