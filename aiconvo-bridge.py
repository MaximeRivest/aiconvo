#!/usr/bin/env python3
"""Transparent PTY bridge for aiconvo.

Alacritty runs this process. This process runs the agent on a real PTY.
A Unix socket lets aiconvo capture the screen and inject keys.
The terminal still looks like a normal Alacritty session.
"""
from __future__ import annotations

import errno
import fcntl
import json
import os
import pty
import select
import signal
import socket
import struct
import sys
import termios
import tty

ESC = 0x1B


def winsize(fd: int) -> tuple[int, int]:
    try:
        packed = fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\x00" * 8)
        rows, cols, _, _ = struct.unpack("HHHH", packed)
        return max(1, rows or 24), max(1, cols or 80)
    except OSError:
        return 24, 80


def tty_is_raw(fd: int) -> bool:
    """True when the PTY slave left canonical mode (the TUI reads raw input).

    Before that, pasted bytes sit in the line discipline and get kernel-echoed;
    a CR sent then merges with the paste when the TUI finally starts reading.
    """
    try:
        lflag = termios.tcgetattr(fd)[3]
        return not (lflag & termios.ICANON)
    except (OSError, termios.error):
        return False


def set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


BLANK = (" ", "")


def _cell(item) -> tuple[str, str]:
    if isinstance(item, tuple) and len(item) == 2:
        return str(item[0]), str(item[1])
    return str(item), ""


def _esc_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Screen:
    """Small VT grid. Enough to read TUI dialogs. Not a full emulator."""

    def __init__(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.r = 0
        self.c = 0
        self.grid = [[BLANK] * cols for _ in range(rows)]
        self.utf8 = bytearray()
        self.esc: list[int] | None = None
        # True after the TUI sends DECSET 2004 (\x1b[?2004h). Only then may a
        # paste carry the 200~/201~ markers; earlier the app prints them as text.
        self.paste2004 = False
        self.bold = False
        self.dim = False
        self.rev = False
        self.fg = None
        self.bg = None

    def _blank_row(self) -> list:
        return [BLANK] * self.cols

    def resize(self, rows: int, cols: int) -> None:
        rows = max(1, rows)
        cols = max(1, cols)
        new = [[BLANK] * cols for _ in range(rows)]
        for i in range(min(rows, self.rows)):
            row = self.grid[i]
            for j in range(min(cols, self.cols)):
                new[i][j] = row[j]
        self.rows, self.cols, self.grid = rows, cols, new
        self.r = min(self.r, rows - 1)
        self.c = min(self.c, cols - 1)

    def _style(self) -> str:
        if self.rev or self._bg_marked():
            return "sel"
        if self._fg_accent() or self.bold:
            return "acc"
        if self.dim:
            return "dim"
        return ""

    def _fg_accent(self) -> bool:
        fg = self.fg
        if fg in (32, 34, 36, 92, 94, 96):
            return True
        if isinstance(fg, int) and fg >= 1000:
            idx = fg - 1000
            if idx in (4, 6, 12, 14, 27, 33, 39, 45, 51):
                return True
            if 16 <= idx <= 231:
                c = idx - 16
                r, g, b = c // 36, (c // 6) % 6, c % 6
                return b >= 4 and b > r and b >= g
        if isinstance(fg, tuple) and len(fg) == 3:
            r, g, b = fg
            return b >= 140 and b > r + 20 and b >= g
        return False

    def _bg_marked(self) -> bool:
        bg = self.bg
        if bg is None:
            return False
        if bg in (40, 49):
            return False
        return True

    def apply_sgr(self, nums: list[int]) -> None:
        if not nums:
            nums = [0]
        i = 0
        while i < len(nums):
            n = nums[i]
            if n == 0:
                self.bold = self.dim = self.rev = False
                self.fg = self.bg = None
            elif n == 1:
                self.bold = True
            elif n == 2:
                self.dim = True
            elif n == 7:
                self.rev = True
            elif n == 22:
                self.bold = self.dim = False
            elif n == 27:
                self.rev = False
            elif n == 39:
                self.fg = None
            elif n == 49:
                self.bg = None
            elif 30 <= n <= 37 or 90 <= n <= 97:
                self.fg = n
            elif 40 <= n <= 47 or 100 <= n <= 107:
                self.bg = n
            elif n in (38, 48):
                kind = n
                if i + 1 < len(nums) and nums[i + 1] == 5:
                    idx = nums[i + 2] if i + 2 < len(nums) else 0
                    i += 2
                    if kind == 38:
                        self.fg = 1000 + idx
                    else:
                        self.bg = 1000 + idx
                elif i + 1 < len(nums) and nums[i + 1] == 2:
                    rgb = nums[i + 2 : i + 5]
                    while len(rgb) < 3:
                        rgb.append(0)
                    i += 1 + len(rgb)
                    if kind == 38:
                        self.fg = (rgb[0], rgb[1], rgb[2])
                    else:
                        self.bg = (rgb[0], rgb[1], rgb[2])
            i += 1

    def snapshot(self) -> str:
        lines = ["".join(_cell(ch)[0] for ch in row).rstrip() for row in self.grid]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)

    def snapshot_html(self) -> str:
        lines = []
        for row in self.grid:
            parts: list[str] = []
            i = 0
            while i < len(row):
                ch, st = _cell(row[i])
                j = i + 1
                while j < len(row) and _cell(row[j])[1] == st:
                    j += 1
                chunk = _esc_html("".join(_cell(row[k])[0] for k in range(i, j)))
                if st:
                    parts.append(f'<span class="term-{st}">{chunk}</span>')
                else:
                    parts.append(chunk)
                i = j
            lines.append("".join(parts).rstrip() or " ")
        while lines and lines[-1].strip() in ("", "&nbsp;"):
            lines.pop()
        return "\n".join(lines)

    def put(self, ch: str) -> None:
        if ch == "\n":
            self.r += 1
            self.c = 0
            if self.r >= self.rows:
                self.grid.pop(0)
                self.grid.append(self._blank_row())
                self.r = self.rows - 1
            return
        if ch == "\r":
            self.c = 0
            return
        if ch == "\b":
            self.c = max(0, self.c - 1)
            return
        if ch == "\t":
            self.c = min(self.cols - 1, (self.c + 8) // 8 * 8)
            return
        if ord(ch) < 32:
            return
        if self.c >= self.cols:
            self.put("\n")
        self.grid[self.r][self.c] = (ch, self._style())
        self.c += 1

    def cup(self, row: int, col: int) -> None:
        self.r = min(max(row - 1, 0), self.rows - 1)
        self.c = min(max(col - 1, 0), self.cols - 1)

    def el(self, mode: int) -> None:
        row = self.grid[self.r]
        if mode == 0:
            for i in range(self.c, self.cols):
                row[i] = BLANK
        elif mode == 1:
            for i in range(0, self.c + 1):
                row[i] = BLANK
        else:
            for i in range(self.cols):
                row[i] = BLANK

    def ed(self, mode: int) -> None:
        if mode == 0:
            self.el(0)
            for r in range(self.r + 1, self.rows):
                self.grid[r] = self._blank_row()
        elif mode == 2 or mode == 3:
            self.grid = [self._blank_row() for _ in range(self.rows)]
            self.r = self.c = 0

    def csi(self, body: str) -> None:
        if not body:
            return
        final = body[-1]
        raw = body[:-1]
        if final in "hl" and raw.startswith("?"):
            modes = [int(p) for p in raw[1:].split(";") if p.isdigit()]
            if 2004 in modes:
                self.paste2004 = final == "h"
            return
        nums = []
        for part in (raw.split(";") if raw else []):
            if part.isdigit():
                nums.append(int(part))
            elif part == "":
                nums.append(0)
        if final == "H" or final == "f":
            self.cup(nums[0] if nums else 1, nums[1] if len(nums) > 1 else 1)
        elif final == "A":
            self.r = max(0, self.r - (nums[0] if nums else 1))
        elif final == "B":
            self.r = min(self.rows - 1, self.r + (nums[0] if nums else 1))
        elif final == "C":
            self.c = min(self.cols - 1, self.c + (nums[0] if nums else 1))
        elif final == "D":
            self.c = max(0, self.c - (nums[0] if nums else 1))
        elif final == "G":
            self.c = min(self.cols - 1, max(0, (nums[0] if nums else 1) - 1))
        elif final == "d":
            self.r = min(self.rows - 1, max(0, (nums[0] if nums else 1) - 1))
        elif final == "J":
            self.ed(nums[0] if nums else 0)
        elif final == "K":
            self.el(nums[0] if nums else 0)
        elif final == "m":
            self.apply_sgr(nums)

    def feed(self, data: bytes) -> None:
        i = 0
        buf = self.utf8
        while i < len(data):
            if self.esc is not None:
                self.esc.append(data[i])
                i += 1
                seq = bytes(self.esc)
                if seq == b"\x1b":
                    continue
                if seq == b"\x1b[":
                    continue
                if seq.startswith(b"\x1b]") :
                    if seq.endswith(b"\x07") or seq.endswith(b"\x1b\\"):
                        self.esc = None
                    elif len(seq) > 256:
                        self.esc = None
                    continue
                if seq.startswith(b"\x1b["):
                    last = seq[-1]
                    if 0x40 <= last <= 0x7E:
                        try:
                            self.csi(seq[2:].decode("ascii", "ignore"))
                        except Exception:
                            pass
                        self.esc = None
                    elif len(seq) > 64:
                        self.esc = None
                    continue
                self.esc = None
                continue
            b = data[i]
            if b == ESC:
                self.esc = [b]
                i += 1
                continue
            if buf or b >= 0x80:
                buf.append(b)
                try:
                    ch = buf.decode("utf-8")
                    buf.clear()
                    self.put(ch)
                except UnicodeDecodeError:
                    if len(buf) > 4:
                        buf.clear()
                i += 1
                continue
            self.put(chr(b))
            i += 1


def parse_args(argv: list[str]) -> tuple[str, list[str]]:
    if len(argv) < 3 or "--" not in argv:
        sys.stderr.write("usage: aiconvo-bridge.py SOCKET -- COMMAND...\n")
        sys.exit(2)
    sock = argv[1]
    cmd = argv[argv.index("--") + 1 :]
    if not cmd:
        sys.stderr.write("aiconvo-bridge: missing command\n")
        sys.exit(2)
    return sock, cmd


def reply(conn: socket.socket, obj: dict) -> None:
    try:
        conn.sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
    except OSError:
        pass


def handle(msg: dict, screen: Screen, master: int) -> dict:
    op = msg.get("op")
    if op == "ping":
        return {"ok": True, "op": "ping", "raw": tty_is_raw(master), "paste": screen.paste2004}
    if op == "capture":
        return {
            "ok": True,
            "text": screen.snapshot(),
            "html": screen.snapshot_html(),
            "rows": screen.rows,
            "cols": screen.cols,
            "raw": tty_is_raw(master),
            "paste": screen.paste2004,
        }
    if op == "keys":
        data = msg.get("data", "")
        if isinstance(data, list):
            data = "".join(str(x) for x in data)
        raw = str(data).encode("utf-8")
        if raw:
            os.write(master, raw)
        return {"ok": True, "n": len(raw)}
    if op == "paste":
        text = str(msg.get("text") or "")
        raw = text.encode("utf-8")
        # Mirror a real terminal: send the bracketed-paste markers only when
        # the application enabled mode 2004. Otherwise the TUI shows them.
        if screen.paste2004:
            raw = b"\x1b[200~" + raw + b"\x1b[201~"
        os.write(master, raw)
        return {"ok": True, "n": len(raw), "bracketed": screen.paste2004}
    if op == "ctrl":
        key = str(msg.get("key") or "v").lower()[:1]
        os.write(master, bytes([ord(key) & 0x1F]))
        return {"ok": True}
    if op == "enter":
        os.write(master, b"\r")
        return {"ok": True}
    if op == "esc":
        os.write(master, b"\x1b")
        return {"ok": True}
    return {"ok": False, "error": "unknown op"}


def main() -> int:
    sock_path, cmd = parse_args(sys.argv)
    os.makedirs(os.path.dirname(sock_path) or ".", exist_ok=True)
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass

    rows, cols = winsize(0)
    pid, master = pty.fork()
    if pid == 0:
        set_winsize(0, rows, cols)
        os.environ["TERM"] = os.environ.get("TERM") or "xterm-256color"
        os.execvp(cmd[0], cmd)

    screen = Screen(rows, cols)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(8)
    server.setblocking(False)
    os.chmod(sock_path, 0o600)

    if sys.stdin.isatty():
        tty.setraw(0)

    winch = {"flag": False}

    def on_winch(_sig, _frm) -> None:
        winch["flag"] = True

    signal.signal(signal.SIGWINCH, on_winch)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)

    for fd in (0, 1, master):
        try:
            os.set_blocking(fd, False)
        except OSError:
            pass

    clients: dict[int, tuple[socket.socket, bytearray]] = {}
    running = True

    def close_client(fd: int) -> None:
        item = clients.pop(fd, None)
        if item:
            try:
                item[0].close()
            except OSError:
                pass

    try:
        while running:
            if winch["flag"]:
                winch["flag"] = False
                rows, cols = winsize(0)
                set_winsize(master, rows, cols)
                screen.resize(rows, cols)

            rlist = [0, master, server.fileno()] + list(clients)
            try:
                readable, _, _ = select.select(rlist, [], [], 0.25)
            except InterruptedError:
                continue

            for fd in readable:
                if fd == 0:
                    try:
                        chunk = os.read(0, 65536)
                    except OSError as e:
                        if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                            continue
                        running = False
                        break
                    if not chunk:
                        running = False
                        break
                    os.write(master, chunk)
                elif fd == master:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as e:
                        if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                            continue
                        running = False
                        break
                    if not chunk:
                        running = False
                        break
                    os.write(1, chunk)
                    screen.feed(chunk)
                elif fd == server.fileno():
                    try:
                        conn, _ = server.accept()
                    except OSError:
                        continue
                    conn.setblocking(False)
                    clients[conn.fileno()] = (conn, bytearray())
                else:
                    conn, buf = clients.get(fd, (None, None))
                    if conn is None:
                        continue
                    try:
                        chunk = conn.recv(65536)
                    except OSError:
                        close_client(fd)
                        continue
                    if not chunk:
                        close_client(fd)
                        continue
                    buf.extend(chunk)
                    while True:
                        nl = buf.find(b"\n")
                        if nl < 0:
                            break
                        line = bytes(buf[:nl]).decode("utf-8", "replace")
                        del buf[: nl + 1]
                        try:
                            msg = json.loads(line or "{}")
                        except json.JSONDecodeError:
                            reply(conn, {"ok": False, "error": "bad json"})
                            continue
                        try:
                            reply(conn, handle(msg, screen, master))
                        except OSError as e:
                            reply(conn, {"ok": False, "error": str(e)})
    finally:
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            server.close()
        except OSError:
            pass
        try:
            os.unlink(sock_path)
        except FileNotFoundError:
            pass
        for fd in list(clients):
            close_client(fd)
        try:
            os.close(master)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
