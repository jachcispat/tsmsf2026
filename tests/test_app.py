import importlib.util
import json
import math
import sys
import unittest
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('tsmsf_app', ROOT / 'app.py')
app = importlib.util.module_from_spec(spec)
sys.modules['tsmsf_app'] = app
spec.loader.exec_module(app)


class SiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / 'static' / 'data.json').read_text(encoding='utf-8'))

    def test_source_counts(self):
        self.assertEqual(len(self.data['matches']), 72)
        self.assertEqual(len(self.data['teams']), 48)
        self.assertEqual(len(self.data['participants']), 15)
        self.assertTrue(all(len(p['predictions']) == 72 for p in self.data['participants']))
        self.assertEqual(sum(1 for p in self.data['participants'] if any(x['home'] is not None for x in p['predictions'])), 13)

    def test_embedded_results(self):
        results = app.embedded_results()
        self.assertEqual(len(results), 4)
        self.assertEqual((results[0]['home'], results[0]['away'], results[0]['homeScore'], results[0]['awayScore']), ('Mexiko','Jižní Afrika',2,0))

    def test_espn_parser(self):
        sample = {
            'events': [{
                'id': '123', 'date': '2026-06-12T02:00Z',
                'status': {'type': {'state': 'post', 'completed': True, 'shortDetail': 'FT'}},
                'competitions': [{'competitors': [
                    {'homeAway': 'home', 'score': '2', 'team': {'displayName': 'Korea Republic'}},
                    {'homeAway': 'away', 'score': '1', 'team': {'displayName': 'Czechia'}},
                ]}]
            }]
        }
        parsed = app.parse_espn_events(sample)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]['home'], 'Jižní Korea')
        self.assertEqual(parsed[0]['away'], 'Česko')
        self.assertTrue(parsed[0]['completed'])
        self.assertEqual((parsed[0]['homeScore'], parsed[0]['awayScore']), (2,1))

    def test_scoring_matches_cached_xlsx(self):
        participants = self.data['participants']
        active = [p for p in participants if any(x['home'] is not None and x['away'] is not None for x in p['predictions'])]
        totals = {p['id']: 0.0 for p in participants}
        for idx, match in enumerate(self.data['matches']):
            result = match['fallbackResult']
            if not result['completed']:
                continue
            ad = result['home'] - result['away']
            correct = 0
            for p in participants:
                tip = p['predictions'][idx]
                ph = tip['home'] if tip['home'] is not None else 0
                pa = tip['away'] if tip['away'] is not None else 0
                td = ph - pa
                if (result['home'] == ph and result['away'] == pa) or ad == td or (ad > 0 and td > 0) or (ad < 0 and td < 0):
                    correct += 1
            x = float((Decimal(len(active)) / Decimal(correct)).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP))
            coefficient = x ** 0.8
            for p in active:
                tip = p['predictions'][idx]
                if tip['home'] is None or tip['away'] is None:
                    continue
                td = tip['home'] - tip['away']
                if result['home'] == tip['home'] and result['away'] == tip['away']:
                    base = 5
                elif ad == td:
                    base = 3
                elif (ad > 0 and td > 0) or (ad < 0 and td < 0):
                    base = 1
                else:
                    base = 0
                totals[p['id']] += base * coefficient
        for p in participants:
            self.assertAlmostEqual(totals[p['id']], p['cachedTotal'], places=8, msg=p['name'])


if __name__ == '__main__':
    unittest.main()
