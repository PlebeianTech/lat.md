import os
import re

CORE_FILES = {
    'cache-path', 'code-refs', 'config', 'context', 'document-formats', 'document-tree',
    'external-documents', 'external-sources', 'format', 'init-version', 'lattice-model',
    'lattice', 'markdown-analysis-cache', 'markdown-analysis-worker', 'markdown-analysis',
    'markdown-analyzer-loader', 'markdown-validation', 'parser-cache', 'parser-import',
    'parser', 'path', 'profiler', 'project-analysis', 'project-discovery', 'project-write',
    'repository-path', 'search-metadata', 'source-formats', 'source-parser', 'untrusted', 'walk'
}

CORE_CLI_FILES = {
    'check-context', 'check', 'context', 'core', 'expand', 'external', 'index', 'locate',
    'paths', 'refs', 'section', 'select-menu', 'check-mode', 'check-status', 'check-frontmatter',
    'check-coverage', 'link-scheme', 'gen-index'
}

def is_core_module(module_path):
    parts = module_path.split('/')
    if 'src' in parts:
        src_idx = parts.index('src')
        rel = parts[src_idx+1:]
        
        # Strip .js
        if rel[-1].endswith('.js'):
            rel[-1] = rel[-1][:-3]
            
        if len(rel) == 1 and rel[0] in CORE_FILES:
            return '@lat.md/core/' + rel[0]
        elif len(rel) == 2 and rel[0] == 'cli' and rel[1] in CORE_CLI_FILES:
            return '@lat.md/core/cli/' + rel[1]
        elif len(rel) == 2 and rel[0] == 'fork' and rel[1] == 'frontmatter-fields':
            return '@lat.md/core/fork/frontmatter-fields'
        elif len(rel) == 3 and rel[0] == 'extensions' and rel[1] == 'wiki-link':
            return '@lat.md/core/extensions/wiki-link/' + rel[2]
            
    return None

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
        
    def repl(m):
        prefix = m.group(1)
        module = m.group(2)
        quote = m.group(3)
        
        # Also need to handle sibling imports in src/cli/ pointing to core cli files
        # e.g. import { ... } from './check.js'; inside src/cli/hook.ts
        if 'src/cli/' in filepath and module.startswith('./'):
            name = module[2:-3] if module.endswith('.js') else module[2:]
            if name in CORE_CLI_FILES:
                return f"{prefix}'@lat.md/core/cli/{name}'"
            elif name == 'check-mode': # etc
                pass
                
        # Handle parent imports pointing to core files
        # e.g. import { ... } from '../context.js'; inside src/cli/hook.ts
        if 'src/cli/' in filepath and module.startswith('../'):
            name = module[3:-3] if module.endswith('.js') else module[3:]
            if name in CORE_FILES:
                return f"{prefix}'@lat.md/core/{name}'"
            if name.startswith('fork/') and name.endswith('frontmatter-fields'):
                return f"{prefix}'@lat.md/core/fork/frontmatter-fields'"

        # Handle tests
        core_mod = is_core_module(module)
        if core_mod:
            return f"{prefix}'{core_mod}'"
            
        return m.group(0)

    # import { ... } from '...';
    # import * as ... from '...';
    # import '...';
    new_content = re.sub(r"(import\s+(?:.*?\s+from\s+)?)(['\"])(.*?)\2", repl, content)
    # await import('...')
    new_content = re.sub(r"(import\()(['\"])(.*?)\2(\))", lambda m: m.group(1) + "'" + (is_core_module(m.group(3)) or m.group(3)) + "'" + m.group(4), new_content)
    
    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Updated {filepath}")

for root, _, files in os.walk('.'):
    if 'node_modules' in root or '.git' in root or 'dist' in root or 'packages' in root:
        continue
    for f in files:
        if f.endswith(('.ts', '.tsx', '.js', '.mjs')):
            process_file(os.path.join(root, f))
