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


def set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


class Screen:
    """Small VT grid. Enough to read TUI dialogs. Not a full emulator."""

    def __init__(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.r = 0
        self.c = 0
        self.grid = [[" "] * cols for _ in range(rows)]
        self.utf8 = bytearray()
        self.esc: list[int] | None = None

    def resize(self, rows: int, cols: int) -> None:
        rows = max(1, rows)
        cols = max(1, cols)
        new = [[" "] * cols for _ in range(rows)]
        for i in range(min(rows, self.rows)):
            row = self.grid[i]
            for j in range(min(cols, self.cols)):
                new[i][j] = row[j]
        self.rows, self.cols, self.grid = rows, cols, new
        self.r = min(self.r, rows - 1)
        self.c = min(self.c, cols - 1)

    def snapshot(self) -> str:
        lines = ["".join(row).rstrip() for row in self.grid]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)

    def put(self, ch: str) -> None:
        if ch == "\n":
            self.r += 1
            self.c = 0
            if self.r >= self.rows:
                self.grid.pop(0)
                self.grid.append([" "] * self.cols)
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
        self.grid[self.r][self.c] = ch
        self.c += 1

    def cup(self, row: int, col: int) -> None:
        self.r = min(max(row - 1, 0), self.rows - 1)
        self.c = min(max(col - 1, 0), self.cols - 1)

    def el(self, mode: int) -> None:
        row = self.grid[self.r]
        if mode == 0:
            for i in range(self.c, self.cols):
                row[i] = " "
        elif mode == 1:
            for i in range(0, self.c + 1):
                row[i] = " "
        else:
            for i in range(self.cols):
                row[i] = " "

    def ed(self, mode: int) -> None:
        if mode == 0:
            self.el(0)
            for r in range(self.r + 1, self.rows):
                self.grid[r] = [" "] * self.cols
        elif mode == 2 or mode == 3:
            self.grid = [[" "] * self.cols for _ in range(self.rows)]
            self.r = self.c = 0

    def csi(self, body: str) -> None:
        if not body:
            return
        final = body[-1]
        raw = body[:-1]
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
            return

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
        return {"ok": True, "op": "ping"}
    if op == "capture":
        return {"ok": True, "text": screen.snapshot(), "rows": screen.rows, "cols": screen.cols}
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
        raw = b"\x1b[200~" + text.encode("utf-8") + b"\x1b[201~"
        os.write(master, raw)
        return {"ok": True, "n": len(raw)}
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
