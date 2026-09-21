import os
import subprocess

files = subprocess.check_output(['git', 'diff', '--name-only', '--diff-filter=U']).decode('utf-8').splitlines()

for f in files:
    print(f"--- {f} ---")
    with open(f, 'r') as fp:
        lines = fp.readlines()
        in_conflict = False
        for i, line in enumerate(lines):
            if line.startswith('<<<<<<<'):
                in_conflict = True
                print(f"L{i}: {line.strip()}")
            elif line.startswith('======='):
                print(f"L{i}: {line.strip()}")
            elif line.startswith('>>>>>>>'):
                print(f"L{i}: {line.strip()}")
                in_conflict = False
