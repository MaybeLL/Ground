"""Exercise the public launcher in a real terminal using a disposable ledger."""
import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

for mode in ('development', '--eval', '--legacy'):
    master, slave = os.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 152, 0, 0))
    args = [] if mode == 'development' else [mode]
    process = subprocess.Popen(sys.argv[1:] + args, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    output = bytearray()

    def wait(text):
        deadline = time.monotonic() + 20
        while text.encode() not in output and time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                output.extend(os.read(master, 65536))
        assert text.encode() in output, (mode, text, output.decode(errors='replace')[-4000:])

    def settle(floor=.05, quiet=.12, cap=1.0):
        """Drain until the terminal has been silent for `quiet`, never before `floor`.

        The floor keeps a key from arriving before Ink registers its input
        handlers; the quiet window replaces the fixed sleeps that used to burn
        their full duration on every press.
        """
        start = last = time.monotonic()
        while True:
            now = time.monotonic()
            if now - start >= cap:
                return
            if select.select([master], [], [], .02)[0]:
                output.extend(os.read(master, 65536))
                last = time.monotonic()
                continue
            if now - start >= floor and now - last >= quiet:
                return

    def press(key):
        # Drain any frame that preceded Ink input effect registration, then send.
        settle(cap=.5)
        output.clear()
        os.write(master, key.encode())
        settle()

    try:
        if mode == '--eval':
            wait("Unknown option '--eval'")
            assert process.wait(timeout=5) == 1
            assert b'\x1b[?1049h' not in output
            assert termios.tcgetattr(slave) == original
            continue
        if mode == 'development':
            wait('查找需求')
            wait('可搜索 0 项 · 下方为可用记录')
            assert '评测工作台'.encode() not in output
            for rows, columns in [(24, 80), (10, 40), (40, 152)]:
                output.clear()
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
                os.kill(process.pid, signal.SIGWINCH)
                # Incremental rendering need not repeat the unchanged title;
                # the resized search/input rows still identify the active view.
                wait('Requirement')
            press('\x05')
            assert '评测工作台'.encode() not in output
        else:
            wait('Requirement')
            settle()
        press('q' if mode == '--legacy' else '\x03')
        wait('\x1b[?1049l')
        assert process.wait(timeout=10) == 0
        assert termios.tcgetattr(slave) == original
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
        os.close(slave)
print('HOME PTY PASS: direct development, resize 152/80/40, retired eval rejection, legacy, terminal restoration')
