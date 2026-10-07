import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/native-host'))
from test_seed import create_full_seed

class FullSeedTest(unittest.TestCase):
    def test_fixture_uses_real_storage_classes_and_requested_quantities(self):
        seed, report = create_full_seed(Path(__file__).resolve().parents[1])
        data = seed['data']
        self.assertEqual(data['00']['9'], 300)
        self.assertEqual(data['0k']['4'], 50)
        self.assertNotIn('7', data['00'])
        groups = {p: [v for k,v in data.items() if k.startswith(p)] for p in ['7','6','8','k','b']}
        self.assertEqual(len(groups['7']), report['items'])
        self.assertTrue(all(v['1'] == 99999 for v in groups['7']))
        self.assertEqual(len(groups['6']), 432)
        self.assertTrue(all(v['2'] == 60 for v in groups['6']))
        self.assertEqual(len(groups['k']), 125)
        self.assertTrue(all(v['1'] == 5 for v in groups['k']))
        self.assertEqual(len(groups['8']), 153)
        self.assertEqual({v['0'] for v in groups['b']}, set(report['localWorlds']))
        self.assertTrue(all(v['0'] not in report['excludedActivityWorlds'] for v in groups['b']))
        self.assertEqual(data['05']['9'], 0)
        self.assertTrue(all(k[0] == '0' or len(k) <= 3 for k in data))

if __name__ == '__main__': unittest.main()
