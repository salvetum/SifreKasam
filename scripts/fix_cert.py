from pathlib import Path
import re, base64
p = Path(r'C:\Users\kaan5\AppData\Roaming\.SifrekasamV2\ssl\cert.pem')
if not p.exists():
    print('cert.pem not found')
    raise SystemExit(0)
s = p.read_bytes()
if b'-----BEGIN CERTIFICATE-----' in s:
    m = re.search(b'-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----', s, re.S)
    if m:
        inner_b = m.group(1).strip()
        try:
            dec = base64.b64decode(inner_b)
            if b'-----BEGIN CERTIFICATE-----' in dec:
                print('Detected double-encoded PEM, fixing...')
                p.write_bytes(dec)
            else:
                print('Inner decode did not yield PEM, leaving as-is')
        except Exception as e:
            print('Base64 decode failed:', e)
    else:
        print('No inner match')
else:
    print('No PEM marker found')
