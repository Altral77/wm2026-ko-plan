/**
 * WM 2026 Tippspiel – Backend (Google Apps Script)
 * ------------------------------------------------------------
 * Speichert alle Daten in DIESEM Google Sheet.
 *
 * EINRICHTUNG:
 *  1) Dieses Skript in das an die Tabelle gebundene Apps-Script-Projekt einfügen
 *     (in der Tabelle: Erweiterungen > Apps Script).
 *  2) Einmal die Funktion  setup  ausführen (legt die Tabellenblätter + 32 Spiele an).
 *     Dabei einmalig die Berechtigungen bestätigen.
 *  3) Bereitstellen > Neue Bereitstellung > Typ: Web-App
 *        - Beschreibung: WM Tippspiel
 *        - Ausführen als: Ich
 *        - Zugriff: Jeder (auch anonym)
 *     -> Web-App-URL kopieren und im Frontend (CONFIG.API_URL) eintragen.
 *  4) Im Blatt "Codes" pro Teilnehmer einen Code eintragen (Spalte Code, Status "frei").
 *  5) Im Blatt "Spiele" Anpfiff (Datum+Uhrzeit), Heim, Gast und später die Tore pflegen.
 * ------------------------------------------------------------
 */

const TZ = 'Europe/Berlin';
const LOCK_MINUTES = 60;            // Tipps schließen 60 Min vor Anpfiff
const SHEETS = {
  codes:       { name: 'Codes',       head: ['Code','Status','Teilnehmer','Datum'] },
  participants:{ name: 'Teilnehmer',  head: ['Id','Name','Email','Token','Code','Registriert'] },
  matches:     { name: 'Spiele',      head: ['Nr','Runde','Anpfiff','Heim','Gast','ToreHeim','ToreGast'] },
  tips:        { name: 'Tipps',       head: ['TeilnehmerId','SpielNr','TippHeim','TippGast','Zeit'] },
};

/* ---------------------- Einrichtung ---------------------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(k => ensureSheet(ss, SHEETS[k].name, SHEETS[k].head));
  seedMatches_(ss);
  SpreadsheetApp.getUi && Logger.log('setup fertig');
}
function ensureSheet(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function seedMatches_(ss) {
  const sh = ss.getSheetByName(SHEETS.matches.name);
  if (sh.getLastRow() > 1) return; // schon befüllt
  const rounds = [];
  for (let n = 73;  n <= 88;  n++) rounds.push([n, 'Sechzehntelfinale', '', '', '', '', '']);
  for (let n = 89;  n <= 96;  n++) rounds.push([n, 'Achtelfinale',      '', '', '', '', '']);
  for (let n = 97;  n <= 100; n++) rounds.push([n, 'Viertelfinale',     '', '', '', '', '']);
  for (let n = 101; n <= 102; n++) rounds.push([n, 'Halbfinale',        '', '', '', '', '']);
  rounds.push([103, 'Spiel um Platz 3', '', '', '', '', '']);
  rounds.push([104, 'Finale',           '', '', '', '', '']);
  sh.getRange(2, 1, rounds.length, 7).setValues(rounds);
}

/* ---------------------- Web-API ---------------------- */
function doGet(e) {
  const a = (e && e.parameter && e.parameter.action) || 'matches';
  try {
    if (a === 'matches')      return json_(apiMatches_(e.parameter.token || ''));
    if (a === 'leaderboard')  return json_(apiLeaderboard_());
    if (a === 'me')           return json_(apiMe_(e.parameter.token || ''));
    return json_({ ok:false, error:'unbekannte Aktion' });
  } catch (err) { return json_({ ok:false, error:String(err) }); }
}
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (x) {}
  try {
    if (body.action === 'register') return json_(apiRegister_(body));
    if (body.action === 'tip')      return json_(apiTip_(body));
    return json_({ ok:false, error:'unbekannte Aktion' });
  } catch (err) { return json_({ ok:false, error:String(err) }); }
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------- Aktionen ---------------------- */
function apiRegister_(b) {
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  const code = String(b.code || '').trim();
  if (!name || !email || !code) return { ok:false, error:'Bitte Name, E-Mail und Code ausfüllen.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok:false, error:'Bitte eine gültige E-Mail eingeben.' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const csh = ss.getSheetByName(SHEETS.codes.name);
    const codes = csh.getDataRange().getValues(); // inkl. Kopf
    let row = -1;
    for (let i = 1; i < codes.length; i++) {
      if (String(codes[i][0]).trim().toLowerCase() === code.toLowerCase()) { row = i; break; }
    }
    if (row < 0) return { ok:false, error:'Code ungültig.' };
    if (String(codes[row][1]).trim().toLowerCase() === 'benutzt') return { ok:false, error:'Dieser Code wurde bereits verwendet.' };

    const psh = ss.getSheetByName(SHEETS.participants.name);
    const id = 'P' + (psh.getLastRow()); // fortlaufend
    const token = Utilities.getUuid();
    psh.appendRow([id, name, email, token, code, new Date()]);
    csh.getRange(row + 1, 2, 1, 3).setValues([['benutzt', name, new Date()]]);
    return { ok:true, token: token, name: name };
  } finally { lock.releaseLock(); }
}

function apiTip_(b) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const p = findParticipant_(ss, b.token);
  if (!p) return { ok:false, error:'Nicht angemeldet. Bitte neu registrieren.' };
  const nr = parseInt(b.matchNr, 10);
  const th = parseInt(b.home, 10), ta = parseInt(b.away, 10);
  if (isNaN(th) || isNaN(ta) || th < 0 || ta < 0 || th > 99 || ta > 99)
    return { ok:false, error:'Bitte gültige Tore (0–99) eingeben.' };

  const msh = ss.getSheetByName(SHEETS.matches.name);
  const matches = msh.getDataRange().getValues();
  let m = null, mrow = -1;
  for (let i = 1; i < matches.length; i++) if (parseInt(matches[i][0],10) === nr) { m = matches[i]; mrow = i; break; }
  if (!m) return { ok:false, error:'Spiel nicht gefunden.' };
  if (!String(m[3]).trim() || !String(m[4]).trim()) return { ok:false, error:'Für dieses Spiel stehen die Teams noch nicht fest.' };
  if (isLocked_(m[2])) return { ok:false, error:'Tippfrist abgelaufen (Tipps schließen ' + LOCK_MINUTES + ' Min vor Anpfiff).' };

  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const tsh = ss.getSheetByName(SHEETS.tips.name);
    const tips = tsh.getDataRange().getValues();
    let trow = -1;
    for (let i = 1; i < tips.length; i++) if (String(tips[i][0]) === p.id && parseInt(tips[i][1],10) === nr) { trow = i; break; }
    if (trow < 0) tsh.appendRow([p.id, nr, th, ta, new Date()]);
    else tsh.getRange(trow + 1, 3, 1, 3).setValues([[th, ta, new Date()]]);
    return { ok:true };
  } finally { lock.releaseLock(); }
}

function apiMatches_(token) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const msh = ss.getSheetByName(SHEETS.matches.name);
  const rows = msh.getDataRange().getValues();
  let myTips = {};
  if (token) {
    const p = findParticipant_(ss, token);
    if (p) myTips = tipsByParticipant_(ss, p.id);
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r[0]) continue;
    const nr = parseInt(r[0],10);
    const kick = r[2] ? new Date(r[2]) : null;
    const hasResult = r[5] !== '' && r[6] !== '' && r[5] !== null && r[6] !== null;
    out.push({
      nr: nr, runde: r[1],
      anpfiff: kick ? kick.toISOString() : null,
      anpfiffText: kick ? Utilities.formatDate(kick, TZ, "dd.MM. HH:mm") : '',
      heim: String(r[3] || ''), gast: String(r[4] || ''),
      bereit: !!(String(r[3]).trim() && String(r[4]).trim()),
      locked: isLocked_(r[2]),
      hasResult: hasResult,
      toreHeim: hasResult ? Number(r[5]) : null,
      toreGast: hasResult ? Number(r[6]) : null,
      tipp: myTips[nr] || null,
    });
  }
  return { ok:true, matches: out, serverZeit: new Date().toISOString() };
}

function apiMe_(token) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const p = findParticipant_(ss, token);
  if (!p) return { ok:false, error:'nicht angemeldet' };
  return { ok:true, name: p.name };
}

function apiLeaderboard_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parts = ss.getSheetByName(SHEETS.participants.name).getDataRange().getValues();
  const matches = ss.getSheetByName(SHEETS.matches.name).getDataRange().getValues();
  const tips = ss.getSheetByName(SHEETS.tips.name).getDataRange().getValues();

  const result = {}; // nr -> [rh,ra]
  for (let i = 1; i < matches.length; i++) {
    const r = matches[i];
    if (r[5] !== '' && r[6] !== '' && r[5] !== null && r[6] !== null)
      result[parseInt(r[0],10)] = [Number(r[5]), Number(r[6])];
  }
  const stats = {}; // id -> {name,punkte,exakt,getippt}
  for (let i = 1; i < parts.length; i++) if (parts[i][0]) stats[parts[i][0]] = { name: parts[i][1], punkte:0, exakt:0, getippt:0 };

  for (let i = 1; i < tips.length; i++) {
    const id = String(tips[i][0]); const nr = parseInt(tips[i][1],10);
    if (!stats[id]) continue;
    stats[id].getippt++;
    const res = result[nr]; if (!res) continue;
    const pts = points_(Number(tips[i][2]), Number(tips[i][3]), res[0], res[1]);
    stats[id].punkte += pts;
    if (pts === 3) stats[id].exakt++;
  }
  const list = Object.keys(stats).map(k => stats[k]);
  list.sort((a,b) => b.punkte - a.punkte || b.exakt - a.exakt || a.name.localeCompare(b.name));
  list.forEach((s,i) => s.platz = i + 1);
  return { ok:true, tabelle: list };
}

/* ---------------------- Helfer ---------------------- */
function points_(th, ta, rh, ra) {
  if ([th,ta,rh,ra].some(v => v === null || v === '' || isNaN(v))) return 0;
  if (th === rh && ta === ra) return 3;
  const dt = th - ta, dr = rh - ra;
  const tendenz = (dt > 0 && dr > 0) || (dt < 0 && dr < 0) || (dt === 0 && dr === 0);
  if (!tendenz) return 0;
  if (dt === dr) return 2;   // gleiche Tordifferenz (inkl. Unentschieden)
  return 1;                   // nur richtige Tendenz
}
function isLocked_(kick) {
  if (!kick) return false;
  const k = new Date(kick).getTime();
  if (isNaN(k)) return false;
  return Date.now() >= (k - LOCK_MINUTES * 60 * 1000);
}
function findParticipant_(ss, token) {
  if (!token) return null;
  const rows = ss.getSheetByName(SHEETS.participants.name).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (String(rows[i][3]) === String(token)) return { id: String(rows[i][0]), name: rows[i][1] };
  return null;
}
function tipsByParticipant_(ss, id) {
  const rows = ss.getSheetByName(SHEETS.tips.name).getDataRange().getValues();
  const map = {};
  for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === id) map[parseInt(rows[i][1],10)] = [Number(rows[i][2]), Number(rows[i][3])];
  return map;
}

/** Hilfsfunktion: erzeugt N zufällige Codes im Blatt "Codes" (im Skripteditor ausführbar). */
function codesErzeugen(anzahl) {
  anzahl = anzahl || 20;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.codes.name);
  const out = [];
  for (let i = 0; i < anzahl; i++) out.push([zufallscode_(), 'frei', '', '']);
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 4).setValues(out);
}
function zufallscode_() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A.charAt(Math.floor(Math.random() * A.length));
  return 'WM-' + s;
}

/* ============================================================
 *  Spielplan-Automatik (Anpfiffzeiten + R32-Teams)
 *  spielplanAktualisieren() ausführen:
 *   - trägt alle Anpfiffzeiten ein (exakte Zeitpunkte, dt. Zeit)
 *   - holt die feststehenden Sechzehntelfinal-Teams (1./2. der Gruppen)
 *     aus dem WM-Planer und füllt leere Heim/Gast-Felder
 *   - vorhandene Einträge & Ergebnisse werden NIE überschrieben
 *  triggerEinrichten() legt einen 6-Stunden-Automatik-Lauf an.
 * ============================================================ */
const KO_JSON_URL = 'https://altral77.github.io/wm2026-ko-plan/tippspiel/ko.json';
// Anpfiff je Spiel als UTC-Zeitpunkt (exakt) – Anzeige erfolgt in dt. Zeit.
const KO_KICKOFF = {
  73:'2026-06-28T19:00:00Z', 74:'2026-06-29T20:30:00Z', 75:'2026-06-30T01:00:00Z', 76:'2026-06-29T17:00:00Z',
  77:'2026-06-30T21:00:00Z', 78:'2026-06-30T17:00:00Z', 79:'2026-07-01T01:00:00Z', 80:'2026-07-01T16:00:00Z',
  81:'2026-07-02T00:00:00Z', 82:'2026-07-01T20:00:00Z', 83:'2026-07-02T23:00:00Z', 84:'2026-07-02T19:00:00Z',
  85:'2026-07-03T03:00:00Z', 86:'2026-07-03T22:00:00Z', 87:'2026-07-04T01:30:00Z', 88:'2026-07-03T18:00:00Z',
  89:'2026-07-04T21:00:00Z', 90:'2026-07-04T17:00:00Z', 91:'2026-07-05T20:00:00Z', 92:'2026-07-06T00:00:00Z',
  93:'2026-07-06T19:00:00Z', 94:'2026-07-07T00:00:00Z', 95:'2026-07-07T16:00:00Z', 96:'2026-07-07T20:00:00Z',
  97:'2026-07-09T20:00:00Z', 98:'2026-07-10T19:00:00Z', 99:'2026-07-11T21:00:00Z', 100:'2026-07-12T01:00:00Z',
  101:'2026-07-14T19:00:00Z', 102:'2026-07-15T19:00:00Z', 103:'2026-07-18T21:00:00Z', 104:'2026-07-19T19:00:00Z',
};

function spielplanAktualisieren() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.matches.name);
  const rows = sh.getDataRange().getValues();

  let ko = {};
  try {
    const txt = UrlFetchApp.fetch(KO_JSON_URL, { muteHttpExceptions: true }).getContentText();
    ko = JSON.parse(txt);
  } catch (e) { /* Teams bleiben dann, wie sie sind */ }

  let zeiten = 0, teams = 0, erg = 0;
  for (let i = 1; i < rows.length; i++) {
    const nr = parseInt(rows[i][0], 10); if (!nr) continue;
    if (KO_KICKOFF[nr]) { sh.getRange(i + 1, 3).setValue(new Date(KO_KICKOFF[nr])); zeiten++; }
    const k = ko[String(nr)];
    if (k) {
      if (k.heim && !String(rows[i][3]).trim()) { sh.getRange(i + 1, 4).setValue(k.heim); teams++; }
      if (k.gast && !String(rows[i][4]).trim()) { sh.getRange(i + 1, 5).setValue(k.gast); teams++; }
      // Ergebnis (nach Verlängerung) – nur wenn Feld leer ist, damit manuelle Korrekturen bleiben
      if (k.th !== null && k.th !== undefined && String(rows[i][5]).trim() === '') { sh.getRange(i + 1, 6).setValue(k.th); erg++; }
      if (k.ta !== null && k.ta !== undefined && String(rows[i][6]).trim() === '') { sh.getRange(i + 1, 7).setValue(k.ta); erg++; }
    }
  }
  Logger.log('Anpfiffzeiten: ' + zeiten + ' | Teams ergänzt: ' + teams + ' | Ergebnisse ergänzt: ' + erg);
}

function triggerEinrichten() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'spielplanAktualisieren') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('spielplanAktualisieren').timeBased().everyHours(6).create();
  Logger.log('Automatik aktiv: spielplanAktualisieren läuft alle 6 Stunden.');
}
