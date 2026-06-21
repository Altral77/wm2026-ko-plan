#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Aktualisiert die WM-2026-Gruppenergebnisse in index.html.

Prinzip (robust):
- Der feste Spielplan (alle 6 Partien je Gruppe, Teams, Datum) steht bereits als
  Geruest im DATA-Block von index.html und wird NICHT veraendert.
- Von den Wikipedia-Gruppenseiten werden nur die ERGEBNISSE geholt und je Partie
  (ueber das Team-Paar) eingetragen.
- Fehlt bei Wikipedia ein Spiel oder schlaegt eine Gruppe fehl, bleibt der bisherige
  Stand dieser Partie/Gruppe erhalten. Es geht also nie etwas kaputt.
"""
import json, re, sys, time, os, urllib.request, urllib.error
from itertools import product

CODE2DE = {
 'MEX':'Mexiko','RSA':'Südafrika','KOR':'Südkorea','CZE':'Tschechien',
 'CAN':'Kanada','BIH':'Bosnien-H.','QAT':'Katar','SUI':'Schweiz',
 'BRA':'Brasilien','MAR':'Marokko','HAI':'Haiti','SCO':'Schottland',
 'USA':'USA','PAR':'Paraguay','AUS':'Australien','TUR':'Türkei',
 'GER':'Deutschland','CUW':'Curaçao','CIV':'Elfenbeinküste','ECU':'Ecuador',
 'NED':'Niederlande','JPN':'Japan','SWE':'Schweden','TUN':'Tunesien',
 'BEL':'Belgien','EGY':'Ägypten','IRN':'Iran','NZL':'Neuseeland',
 'ESP':'Spanien','CPV':'Kap Verde','KSA':'Saudi-Arabien','URU':'Uruguay',
 'FRA':'Frankreich','SEN':'Senegal','IRQ':'Irak','NOR':'Norwegen',
 'ARG':'Argentinien','ALG':'Algerien','AUT':'Österreich','JOR':'Jordanien',
 'POR':'Portugal','COD':'DR Kongo','UZB':'Usbekistan','COL':'Kolumbien',
 'ENG':'England','CRO':'Kroatien','GHA':'Ghana','PAN':'Panama',
}
DE2CODE = {v: k for k, v in CODE2DE.items()}
GROUPS = "ABCDEFGHIJKL"
API = ("https://en.wikipedia.org/w/api.php?action=parse"
       "&page=2026_FIFA_World_Cup_Group_{}&prop=wikitext&format=json&formatversion=2")

def fetch(g, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(API.format(g),
                headers={'User-Agent': 'wm2026-ko-plan updater (github actions)'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)['parse']['wikitext']
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                time.sleep(3 * (i + 1))  # Backoff bei Rate-Limit
                continue
            raise
    raise last

def parse_results(t):
    """frozenset({code1,code2}) -> (code1, score1, score2)  oder None (Spiel angesetzt)."""
    res = {}
    for b in re.split(r'#invoke:football box', t)[1:]:
        m1 = re.search(r'team1=\{\{#invoke:flag\|fb(?:-rt)?\|([A-Z]{3})\}\}', b)
        m2 = re.search(r'team2=\{\{#invoke:flag\|fb(?:-rt)?\|([A-Z]{3})\}\}', b)
        if not m1 or not m2:
            continue
        c1, c2 = m1.group(1), m2.group(1)
        sc = re.search(r'score=\{\{score link\|[^|]*\|([^}]+)\}\}', b)
        ms = re.search(r'(\d+)\s*[–-]\s*(\d+)', sc.group(1)) if sc else None
        res[frozenset((c1, c2))] = (c1, int(ms.group(1)), int(ms.group(2))) if ms else None
    return res

def update_group(text, results):
    """text = JS-Objekt '{teams:[...],matches:[...]}'. Ergebnisse je Paar eintragen."""
    teams = re.findall(r'"((?:[^"\\]|\\.)*)"', re.search(r'teams:\[(.*?)\]', text, re.S).group(1))
    def repl(m):
        h, a = int(m.group(1)), int(m.group(2))
        date = m.group(5)
        ch, ca = DE2CODE.get(teams[h]), DE2CODE.get(teams[a])
        key = frozenset((ch, ca))
        if key in results:
            r = results[key]
            if r is None:
                hs = as_ = 'null'                       # angesetzt
            else:
                c1, s1, s2 = r
                hs, as_ = (s1, s2) if c1 == ch else (s2, s1)
        else:
            hs, as_ = m.group(3), m.group(4)            # Wikipedia hat das Spiel (noch) nicht -> behalten
        return f'[{h},{a},{hs},{as_},"{date}"]'
    new = re.sub(r'\[(\d+),(\d+),(null|\d+),(null|\d+),"([^"]*)"\]', repl, text)
    return new

# --- Sechzehntelfinale: welcher Slot speist welches Spiel (für ko.json) ---
# Slot: ('1',G)=Gruppensieger, ('2',G)=Gruppenzweiter, ('3',)=Gruppendritter (bleibt offen)
R32 = {
 73:[('2','A'),('2','B')], 74:[('1','E'),('3',)], 75:[('1','F'),('2','C')], 76:[('1','C'),('2','F')],
 77:[('1','I'),('3',)],    78:[('2','E'),('2','I')], 79:[('1','A'),('3',)], 80:[('1','L'),('3',)],
 81:[('1','D'),('3',)],    82:[('1','G'),('3',)],   83:[('2','K'),('2','L')], 84:[('1','H'),('2','J')],
 85:[('1','B'),('3',)],    86:[('1','J'),('2','H')], 87:[('1','K'),('3',)],  88:[('2','D'),('2','G')],
}

def parse_group_js(text):
    tm = re.search(r'teams:\[(.*?)\]', text, re.S).group(1)
    teams = re.findall(r'"((?:[^"\\]|\\.)*)"', tm)
    matches = []
    for m in re.finditer(r'\[(\d+),(\d+),(null|\d+),(null|\d+),"([^"]*)"\]', text):
        hs = None if m.group(3) == 'null' else int(m.group(3))
        as_ = None if m.group(4) == 'null' else int(m.group(4))
        matches.append((int(m.group(1)), int(m.group(2)), hs, as_, m.group(5)))
    return teams, matches

def group_locks(teams, matches):
    """Gibt (Sieger, Zweiter) zurück, sofern bereits eindeutig feststehend, sonst None."""
    n = len(teams); base = [0]*n; rem = []
    for h, a, hs, as_, _ in matches:
        if hs is not None and as_ is not None:
            if hs > as_: base[h] += 3
            elif hs < as_: base[a] += 3
            else: base[h] += 1; base[a] += 1
        else: rem.append((h, a))
    can1, can2 = set(), set()
    for combo in product(range(3), repeat=len(rem)):
        p = base[:]
        for o, (h, a) in zip(combo, rem):
            if o == 0: p[h] += 3
            elif o == 1: p[h] += 1; p[a] += 1
            else: p[a] += 3
        for t in range(n):
            g = sum(1 for u in range(n) if u != t and p[u] > p[t])
            e = sum(1 for u in range(n) if u != t and p[u] == p[t])
            if g == 0: can1.add(t)
            if g <= 1 and g + e >= 1: can2.add(t)
    l1 = teams[next(iter(can1))] if len(can1) == 1 else None
    l2 = teams[next(iter(can2))] if len(can2) == 1 else None
    return l1, l2

def write_ko_json(groups):
    locks = {}
    for g in GROUPS:
        teams, matches = parse_group_js(groups[g])
        l1, l2 = group_locks(teams, matches)
        locks[g] = {'1': l1, '2': l2}
    def resolve(slot):
        if slot[0] == '3': return None       # Gruppendritte erst nach FIFA-Zuordnung -> manuell
        return locks[slot[1]][slot[0]]
    ko = {}
    for nr, (hs, gs) in R32.items():
        ko[str(nr)] = {'heim': resolve(hs), 'gast': resolve(gs)}
    os.makedirs('tippspiel', exist_ok=True)
    open('tippspiel/ko.json', 'w', encoding='utf-8').write(json.dumps(ko, ensure_ascii=False))
    n_locked = sum(1 for v in ko.values() if v['heim'] or v['gast'])
    print(f"ko.json geschrieben ({n_locked}/16 R32-Spiele mit mind. einem fixen Team)")

def main():
    html = open('index.html', encoding='utf-8').read()
    block = re.search(r'/\*DATA_START\*/(.*?)/\*DATA_END\*/', html, re.S)
    if not block:
        print("FEHLER: DATA-Marker nicht gefunden.", file=sys.stderr); sys.exit(1)
    groups = dict(re.findall(r'([A-L]):(\{[^{}]*\})', block.group(1)))
    if len(groups) != 12:
        print(f"FEHLER: {len(groups)} Gruppen im DATA-Block (erwartet 12).", file=sys.stderr); sys.exit(1)

    updated, kept = [], []
    for g in GROUPS:
        try:
            results = parse_results(fetch(g))
            if not results:
                raise ValueError("keine Spiele gefunden")
            groups[g] = update_group(groups[g], results)
            updated.append(g)
        except Exception as e:
            print(f"WARN Gruppe {g}: {e} -> bisheriger Stand bleibt", file=sys.stderr)
            kept.append(g)
        time.sleep(0.8)  # hoeflich gegenueber Wikipedia

    inner = "\n " + ",\n ".join(f"{g}:{groups[g]}" for g in GROUPS) + "\n"
    new_html = html[:block.start(1)] + inner + html[block.end(1):]
    open('index.html', 'w', encoding='utf-8').write(new_html)
    print(f"OK. Aktualisiert: {updated} | unveraendert/Fallback: {kept} | "
          f"Datei geaendert: {new_html != html}")
    try:
        write_ko_json(groups)
    except Exception as e:
        print('WARN ko.json:', e, file=sys.stderr)

if __name__ == '__main__':
    main()
