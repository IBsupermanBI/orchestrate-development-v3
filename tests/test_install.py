import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('package_install', ROOT / 'install.py')
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)

class InstallTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / '.scratch'
        scratch.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / 'project'

    def test_dry_run_roundtrip_and_idempotence(self):
        INSTALL.install(ROOT, self.target)
        self.assertFalse(self.target.exists())
        INSTALL.install(ROOT, self.target, apply=True)
        manifest = json.loads((ROOT / 'install-manifest.json').read_text())
        for asset in manifest['project_assets']:
            self.assertEqual((ROOT / asset['source']).read_bytes(), (self.target / asset['destination']).read_bytes())
            tomllib.loads((self.target / asset['destination']).read_text())
        self.assertFalse((self.target / '.codex/hooks.json').exists())
        self.assertFalse((self.target / 'AGENTS.md').exists())
        self.assertFalse((self.target / '.agents/skills' / manifest['skill_name'] / '.git').exists())
        self.assertFalse((self.target / '.agents/skills' / manifest['skill_name'] / 'optional').exists())
        self.assertTrue(all(o['action'] == 'unchanged' for o in INSTALL.install(ROOT, self.target, apply=True)['operations']))

    def test_conflict_backup_and_unrelated_preservation(self):
        INSTALL.install(ROOT, self.target, apply=True)
        destination = self.target / '.agents/skills/orchestrate-development-v3/SKILL.md'
        destination.write_text('local edit')
        unrelated = self.target / 'AGENTS.md'
        unrelated.write_text('project contract')
        with self.assertRaises(ValueError):
            INSTALL.install(ROOT, self.target, apply=True)
        self.assertEqual(destination.read_text(), 'local edit')
        INSTALL.install(ROOT, self.target, apply=True, force=True)
        self.assertEqual(destination.read_bytes(), (ROOT / 'SKILL.md').read_bytes())
        self.assertEqual(unrelated.read_text(), 'project contract')
        self.assertEqual(next(destination.parent.glob('.backups/*/SKILL.md')).read_text(), 'local edit')

    def test_user_scope(self):
        INSTALL.install(ROOT, self.target, user=True, apply=True)
        self.assertTrue((self.target / 'skills/orchestrate-development-v3/SKILL.md').exists())
        self.assertTrue((self.target / 'agents/astra-low-worker.toml').exists())
        self.assertFalse((self.target / 'hooks.json').exists())

    def test_path_escape_rejected(self):
        for name in ('../outside', str(ROOT.resolve())):
            with self.assertRaises(ValueError):
                INSTALL.inside(self.target, name)

    def test_required_profiles_exact(self):
        expected = {
            'astra-low-worker': ('gpt-6-astra', 'low'),
            'luna-xhigh-worker': ('gpt-5.6-luna', 'xhigh'),
            'terra-high-gate': ('gpt-5.6-terra', 'high'),
            'v3-sol-medium-reviewer': ('gpt-5.6-sol', 'medium'),
            'v3-luna-xhigh-validator': ('gpt-5.6-luna', 'xhigh'),
        }
        manifest = json.loads((ROOT / 'install-manifest.json').read_text())
        actual = {}
        for asset in manifest['project_assets']:
            data = tomllib.loads((ROOT / asset['source']).read_text())
            actual[data['name']] = (data['model'], data['model_reasoning_effort'])
        self.assertEqual(actual, expected)

if __name__ == '__main__':
    unittest.main()
