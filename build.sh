#!/usr/bin/env bash
# ./build.sh pack          build dist/nextcloud-qs.zip (upload to extensions.gnome.org);
#                          VERSION_NAME=v1 ./build.sh pack builds dist/nextcloud-qs-v1.zip with that version-name
# ./build.sh install       pack and install it for your user (log out and in to load it)
# ./build.sh uninstall     remove it again
# ./build.sh translations  refresh translations.json from the Nextcloud client's repo
set -euo pipefail
cd "$(dirname "$0")"
UUID=nextcloud-quick-settings@k0-3n.github.io
ZIP=dist/nextcloud-qs${VERSION_NAME:+-$VERSION_NAME}.zip
FILES=(metadata.json extension.js client.js cloudproviders.js tray.js translations.json LICENSE icons)

# Plain zip instead of `gnome-extensions pack`, so it also runs on CI machines
# without GNOME Shell. The extension has no schemas or gettext files to compile.
pack() {
    mkdir -p dist
    rm -f "$ZIP"
    VERSION_NAME="${VERSION_NAME:-}" python3 -I - "$ZIP" "${FILES[@]}" <<'PY'
import json, os, re, sys, zipfile
from pathlib import Path
out, *names = sys.argv[1:]
version_name = os.environ['VERSION_NAME']
# extensions.gnome.org: 1-16 letters, digits, spaces and periods
if version_name and not re.fullmatch(r'(?![. ]+$)[A-Za-z0-9 .]{1,16}', version_name):
    sys.exit(f'Invalid version-name: {version_name!r}')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for name in names:
        path = Path(name)
        for f in sorted([path] if path.is_file() else path.rglob('*')):
            if not f.is_file():
                continue
            if f.as_posix() == 'metadata.json' and version_name:
                metadata = json.loads(f.read_text())
                metadata['version-name'] = version_name
                zf.writestr('metadata.json', json.dumps(metadata, indent=2, ensure_ascii=False) + '\n')
            else:
                zf.write(f, f.as_posix())
PY
    echo "$ZIP"
}

translations() {
    local tmp
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    git clone --quiet --depth 1 --filter=blob:none --sparse \
        https://github.com/nextcloud/desktop.git "$tmp/desktop"
    git -C "$tmp/desktop" sparse-checkout set translations
    python3 -I tools/extract-translations.py "$tmp/desktop/translations" > translations.json
    git diff --stat -- translations.json
}

case "${1:-}" in
    pack) pack ;;
    install) pack && gnome-extensions install --force "$ZIP" ;;
    uninstall) gnome-extensions uninstall "$UUID" ;;
    translations) translations ;;
    *) sed -n '2,6p' "$0" | sed 's/^# //'; exit 1 ;;
esac
