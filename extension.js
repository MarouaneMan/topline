import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const DEBOUNCE_MS = 500;
const MAX_ATTEMPTS = 4;
const TICK_MS = 100;
const NO_LINE = -2;
const CACHE_MAX = 200;
const LEAD_MS = 500; // show each line slightly before it's sung

const STATUS = {
  fetching: 'Looking for lyrics on LRCLIB…',
  synced: n => `Synced lyrics found (${n} lines)`,
  notSynced: 'LRCLIB has the lyrics for this song, but without timestamps, ' +
    'so they can\'t follow the music',
  notFound: 'LRCLIB doesn\'t know this song (it may be missing, ' +
    'or the title or duration doesn\'t match)',
  unexpected: code => `Unexpected answer from LRCLIB (HTTP ${code})`,
  serverBusy: (code, s, i) =>
    `LRCLIB is busy (HTTP ${code}), retrying in ${s}s (attempt ${i}/${MAX_ATTEMPTS})`,
  network: (msg, s, i) =>
    `Can't reach LRCLIB (${msg}), retrying in ${s}s (attempt ${i}/${MAX_ATTEMPTS})`,
  gaveUp: `Couldn't get an answer from LRCLIB after ${MAX_ATTEMPTS} attempts. ` +
    'It will try again next time this song plays',
  noDuration: 'The player didn\'t report the song length, so lyrics can\'t be looked up',
};

export default class ToplineExtension extends Extension {
  enable() {
    // false = create a dropdown menu (shows the status on click)
    this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
    this._label = new St.Label({ text: '', y_align: Clutter.ActorAlign.CENTER });
    this._button.add_child(this._label);

    this._statusItem = new PopupMenu.PopupMenuItem('', { reactive: false });
    this._button.menu.addMenuItem(this._statusItem);

    Main.panel.addToStatusArea(this.uuid, this._button, 0, 'center');
    this._button.hide(); // shown when the first song settles

    this._session = new Soup.Session({ user_agent: 'topline (GNOME Shell extension)' });
    this._cancellable = new Gio.Cancellable();
    this._cache = new Map(); // cacheKey -> {lines, status}
    this._debounceId = 0;
    this._retryId = 0;
    this._pending = null;
    this._currentKey = null;
    this._playerBus = null;
    this._lines = [];
    this._lineIndex = NO_LINE;

    // Local clock: position = anchorPos + (now - anchorTime) while playing
    this._playing = false;
    this._anchorPosUs = 0;
    this._anchorTimeUs = null;

    const bus = Gio.DBus.session;
    this._propsSignalId = bus.signal_subscribe(
      null, PROPS_IFACE, 'PropertiesChanged', MPRIS_PATH, null,
      Gio.DBusSignalFlags.NONE, this._onPropertiesChanged.bind(this));
    this._seekedSignalId = bus.signal_subscribe(
      null, MPRIS_PLAYER_IFACE, 'Seeked', MPRIS_PATH, null,
      Gio.DBusSignalFlags.NONE, this._onSeeked.bind(this));

    this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
      this._tick();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _setStatus(text) {
    this._statusItem.label.text = text;
  }

  _onPropertiesChanged(_conn, sender, _path, _iface, _signal, params) {
    const [ifaceName, changed] = params.recursiveUnpack();
    if (ifaceName !== MPRIS_PLAYER_IFACE)
      return;

    // Pause / play on our player: re-anchor the clock
    if (changed.PlaybackStatus && sender === this._playerBus)
      this._resync();

    if (!changed.Metadata)
      return;

    const md = changed.Metadata;
    const title = md['xesam:title'];
    const artist = md['xesam:artist']?.[0];
    const lengthUs = md['mpris:length'] ?? 0;
    if (!title || !artist)
      return;

    this._pending = { sender, artist, title, durationSec: Math.round(lengthUs / 1e6) };

    if (this._debounceId)
      GLib.Source.remove(this._debounceId);
    this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
      this._debounceId = 0;
      this._onTrackSettled(this._pending);
      return GLib.SOURCE_REMOVE;
    });
  }

  _onSeeked(_conn, sender, _path, _iface, _signal, params) {
    if (sender !== this._playerBus)
      return;
    // The signal carries the new position (µs): no D-Bus call needed
    [this._anchorPosUs] = params.recursiveUnpack();
    this._anchorTimeUs = GLib.get_monotonic_time();
  }

  _onTrackSettled({ sender, artist, title, durationSec }) {
    this._button.show();
    this._playerBus = sender;
    this._resync(); // always: even the same song may have restarted

    const key = `${artist}\n${title}`;
    if (key === this._currentKey)
      return;
    this._currentKey = key;
    this._lines = [];
    this._lineIndex = NO_LINE;
    this._label.text = `${artist} - ${title}`; // stays here if anything fails

    if (durationSec <= 0) {
      this._setStatus(STATUS.noDuration);
      return;
    }

    const cacheKey = `${key}\n${durationSec}`;
    const cached = this._cache.get(cacheKey);
    if (cached) {
      this._applyResult(cached, true);
      return;
    }
    this._fetchLyrics(key, cacheKey, artist, title, durationSec)
      .catch(e => logError(e, 'topline'));
  }

  _applyResult({ lines, status }, fromCache = false) {
    this._lines = lines;
    this._lineIndex = NO_LINE;
    this._setStatus(fromCache ? `${status} (from cache)` : status);
  }

  _remember(cacheKey, result) {
    // Map keeps insertion order: the first key is the oldest
    if (this._cache.size >= CACHE_MAX)
      this._cache.delete(this._cache.keys().next().value);
    this._cache.set(cacheKey, result);
  }

  // Read Position + PlaybackStatus in one call, and re-anchor the clock
  _resync() {
    if (!this._playerBus)
      return;
    Gio.DBus.session.call(
      this._playerBus, MPRIS_PATH, PROPS_IFACE, 'GetAll',
      new GLib.Variant('(s)', [MPRIS_PLAYER_IFACE]),
      new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 1000, this._cancellable,
      (conn, res) => {
        let props;
        try {
          [props] = conn.call_finish(res).recursiveUnpack();
        } catch (_e) {
          return; // player gone, or extension disabled
        }
        this._playing = props.PlaybackStatus === 'Playing';
        this._anchorPosUs = props.Position ?? 0;
        this._anchorTimeUs = GLib.get_monotonic_time();
      });
  }

  _positionMs() {
    const elapsedUs = this._playing ? GLib.get_monotonic_time() - this._anchorTimeUs : 0;
    return (this._anchorPosUs + elapsedUs) / 1000;
  }

  _tick() {
    if (!this._lines.length || this._anchorTimeUs === null)
      return;
    this._showLineAt(this._positionMs() + LEAD_MS);
  }

  async _fetchLyrics(key, cacheKey, artist, title, durationSec) {
    const url = 'https://lrclib.net/api/get' +
      `?artist_name=${encodeURIComponent(artist)}` +
      `&track_name=${encodeURIComponent(title)}` +
      `&duration=${durationSec}`;
    console.log(`topline: GET ${url}`);
    this._setStatus(STATUS.fetching);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const delayS = 2 ** attempt; // 1s, 2s, 4s, 8s
      const msg = Soup.Message.new('GET', url);
      let bytes;
      try {
        bytes = await this._session.send_and_read_async(
          msg, GLib.PRIORITY_DEFAULT, this._cancellable);
      } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
          return;
        this._setStatus(STATUS.network(e.message, delayS, attempt + 1));
        await this._sleep(delayS * 1000);
        continue;
      }

      if (key !== this._currentKey)
        return; // song changed while we were waiting: drop the result

      const status = msg.get_status();
      if (status >= 500 || status === 429) {
        this._setStatus(STATUS.serverBusy(status, delayS, attempt + 1));
        await this._sleep(delayS * 1000);
        continue;
      }

      if (status === 404) {
        const result = { lines: [], status: STATUS.notFound };
        this._remember(cacheKey, result);
        this._applyResult(result);
        return;
      }

      if (status !== 200) {
        this._setStatus(STATUS.unexpected(status)); // not cached
        return;
      }

      const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
      const lines = parseLrc(json.syncedLyrics ?? '');
      const result = {
        lines,
        status: lines.length ? STATUS.synced(lines.length) : STATUS.notSynced,
      };
      this._remember(cacheKey, result);
      this._applyResult(result);
      return;
    }
    this._setStatus(STATUS.gaveUp);
  }

  _showLineAt(positionMs) {
    const i = findLineIndex(this._lines, positionMs);
    if (i === this._lineIndex)
      return;
    this._lineIndex = i;
    const text = i >= 0 ? this._lines[i].text : '';
    this._label.text = text || '♪'; // instrumental part or before first line
  }

  _sleep(ms) {
    return new Promise(resolve => {
      this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        this._retryId = 0;
        resolve();
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  disable() {
    for (const id of [this._propsSignalId, this._seekedSignalId])
      if (id)
        Gio.DBus.session.signal_unsubscribe(id);
    this._propsSignalId = this._seekedSignalId = 0;

    for (const id of [this._debounceId, this._retryId, this._tickId])
      if (id)
        GLib.Source.remove(id);
    this._debounceId = this._retryId = this._tickId = 0;

    this._cancellable?.cancel();
    this._session?.abort();
    this._cancellable = this._session = null;
    this._cache = null;

    this._button?.destroy(); // also destroys the menu and its items
    this._button = this._label = this._statusItem = null;
  }
}

// "[01:04.92] Looking at the stars" -> {timeMs: 64920, text: "..."}
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (m)
      lines.push({ timeMs: Math.round((+m[1] * 60 + +m[2]) * 1000), text: m[3] });
  }
  return lines;
}

// Index of the last line with timeMs <= positionMs, or -1 if none
function findLineIndex(lines, positionMs) {
  let lo = 0, hi = lines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
