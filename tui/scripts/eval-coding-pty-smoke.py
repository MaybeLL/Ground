"""Exercise Eval UI and editor terminal ownership using the temporary CLI fixture."""
import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = os.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()

def collect(seconds=.25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], .03)[0]:
            output.extend(os.read(master, 65536))

def wait(text, timeout=30):
    deadline = time.monotonic() + timeout
    while text.encode() not in output and time.monotonic() < deadline:
        collect(.1)
        if process.poll() is not None:
            break
    assert text.encode() in output, 'Missing ' + text + '\n' + output.decode(errors='replace')[-5000:]

def press(keys):
    os.write(master, keys.encode())
    collect()

try:
    # The dashboard already lists experiments. Navigate by the fixed fixture
    # ID rather than an obsolete root-menu row offset.
    wait('评测工作台 · 实验与结果')
    wait('读取于')
    press('/')
    press(os.environ['GROUNDS_TUI_CODING_EXPERIMENT'])
    wait('筛选：' + os.environ['GROUNDS_TUI_CODING_EXPERIMENT'])
    press('\r')
    output.clear()
    press('\r')
    # Snapshot also appears in the dashboard preview while navigation is busy.
    # The nested-page footer is rendered only after the action has completed.
    wait('Ctrl+R 刷新 · q 退出')
    wait('Snapshot')
    press('\r')
    wait('逐题审阅')
    press(':')
    press('\x1b[B')
    press('\x1b[B')
    press('\r')
    wait('交付概览')
    collect(2)
    press('\t')
    wait('关联依据')
    output.clear()
    press('\x05')
    wait('当前操作')
    press('\x1b')
    wait('逐题审阅')
    press('q')
    wait('\x1b[?1049l')
    assert process.wait(timeout=10) == 0
    assert termios.tcgetattr(slave) == original
    print('EVAL CODING PTY PASS: experiment -> Candidate fixed code -> Eval return')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
