#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Collect the Nextcloud client's tray "Pause sync" / "Resume sync" labels in
every language from its Qt translation files (translations/client_*.ts in
https://github.com/nextcloud/desktop) and print them as JSON.

Usage: extract-translations.py <nextcloud-desktop>/translations > translations.json
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

CONTEXT = 'OCC::Systray'
SOURCES = {
    'Pause sync': 'pause',
    'Pause sync for all': 'pause',
    'Resume sync': 'resume',
    'Resume sync for all': 'resume',
}
SKIP_TYPES = {'unfinished', 'obsolete', 'vanished'}


def clean(label):
    # Qt marks the keyboard accelerator with "&" ("&&" is a literal "&")
    return label.replace('&&', '\0').replace('&', '').replace('\0', '&').strip()


def main(ts_dir):
    files = sorted(Path(ts_dir).glob('client_*.ts'))
    if not files:
        sys.exit(f'No client_*.ts files in {ts_dir}')

    labels = {'pause': set(), 'resume': set()}
    for source, kind in SOURCES.items():
        labels[kind].add(source)

    for path in files:
        root = ET.parse(path).getroot()
        for context in root.iter('context'):
            if context.findtext('name') != CONTEXT:
                continue
            for message in context.iter('message'):
                kind = SOURCES.get(message.findtext('source'))
                translation = message.find('translation')
                if kind is None or translation is None:
                    continue
                if translation.get('type') in SKIP_TYPES or not translation.text:
                    continue
                labels[kind].add(clean(translation.text))

    for kind in labels:
        labels[kind].discard('')
    if labels['pause'] & labels['resume']:
        sys.exit(f"Same label for pause and resume: {labels['pause'] & labels['resume']}")

    json.dump({kind: sorted(values) for kind, values in labels.items()},
              sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write('\n')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip())
    main(sys.argv[1])
