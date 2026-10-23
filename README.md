# Topline

Synced lyrics in the GNOME top bar.

Topline listens to whatever is playing (YouTube Music in the browser, Spotify, VLC, any MPRIS player), fetches time-synced lyrics from [LRCLIB](https://lrclib.net), and shows the current line in the center of the top bar.

In songwriting, the *topline* is the vocal melody and lyrics. Here, it also lives on the top line of your screen.

## Requirements

- GNOME Shell 50
- A media player that supports MPRIS (most do, including Chromium-based browsers and Firefox)

## Install

```bash
git clone <repo-url> ~/personal/projects/topline
ln -s ~/personal/projects/topline ~/.local/share/gnome-shell/extensions/topline@nox
```

Log out and back in (GNOME only discovers new extensions at startup on Wayland), then:

```bash
gnome-extensions enable topline@nox
```

## Usage

Play a song. The top bar shows:

- the current lyrics line, when synced lyrics are found
- `♪` during instrumental parts
- `artist - title` when no synced lyrics are available

Click the text to see the full lyrics, with the current line highlighted. When there are no synced lyrics, the popup shows the lookup status instead (not found, no timestamps, server busy…).

Media without an album are ignored. Browsers expose a single MPRIS player for all tabs, so without this a video on X or another site would take over the top bar.

## How it works

1. **Track detection.** Subscribes to MPRIS `PropertiesChanged` signals on the session D-Bus. A track change emits a burst of partial updates, so they are debounced (500 ms) and only `artist + title` is used as the track key.
2. **Lyrics lookup.** Calls LRCLIB's `/api/get` with artist, title, and duration. Retries with exponential backoff (1 s, 2 s, 4 s, 8 s) on 5xx, 429, and network errors. Results that are final (found, 404, no timestamps) are cached in memory, up to 200 tracks.
3. **Playback clock.** The position is read once from the player, then computed locally: `position = anchor + elapsed` while playing. It is re-anchored on track change, play/pause (`PlaybackStatus`), and seek (`Seeked` signal).
4. **Display.** A binary search finds the current line every 100 ms. Lines are shown 500 ms early (`LEAD_MS`) so the text doesn't feel late.

## Development

GNOME caches extension code, so testing changes in your real session needs a log out each time. Use a nested shell instead:

```bash
sudo apt install mutter-dev-bin
dbus-run-session gnome-shell --devkit --wayland
```

The nested shell has its own D-Bus session bus, so start a player from a terminal inside it. Test tracks with exact durations (FLAC, since players often misreport MP3 durations):

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=322" \
  -metadata artist="The Blaze" -metadata title="Virile" /tmp/virile.flac
vlc /tmp/virile.flac
```

Logs from the nested shell appear in the terminal that launched it. In the real session:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Known limitations

- **Duration mismatch.** LRCLIB matches durations within about ±2 s. YouTube versions are sometimes a few seconds longer than album versions, so the lookup can miss or return an entry without timestamps.
- **Version offset.** If a version has extra seconds at the start, every line will be late by that amount.
- **Long lines** are not truncated or scrolled.

## Credits

Lyrics by [LRCLIB](https://lrclib.net), a free and open lyrics database.
