"""Exercise the installed review entry in a real PTY; all data is the integration fixture."""
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 160, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()

def collect(seconds=.3):
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

def action(query):
    press(':')
    press(query)
    press('\r')

try:
    wait('需求开发')
    press('\r')
    wait('找到需求，阅读需求详情')
    wait('Describe the requirement')
    output.clear()
    press('\r')
    wait('需求原文')
    output.clear()
    press('\t')
    wait('关联 Issue')
    output.clear()
    press('\r')
    wait('Issue 详情')
    output.clear()
    press('\x1b')
    wait('关联 Issue')
    output.clear()
    press('\x1b')
    wait('需求原文')
    output.clear()
    press('\x1b')
    wait('查找需求')
    press('\x14')
    wait('找到任务，开始审阅')
    collect(2)
    press('\r')
    wait('没有候选')  # Latest Issue v2 has no candidates; contract remains readable.
    action('切换 Issue')
    wait('Issue 版本')
    press('\r')  # v1
    wait('Fixture one')
    press('\r')
    wait('交付概览')
    collect(3)
    for key in ('\x1b[B', '\x1b[A'):
        output.clear()
        press(key)
        assert output, 'No navigation update'
        assert output.count(b'\x1b[2K') < 12 and b'\x1b[2J' not in output, 'Whole viewport erased'
    press('\t')
    wait('范围：')
    wait('Tab 切换页签')
    wait('关联依据 · 摘要')
    wait('修改说明 1 条')
    action('原始验证报告')
    wait('报告原文')
    press('\x1b')
    output.clear()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 110, 0, 0))
    os.kill(process.pid, signal.SIGWINCH)
    wait('关联依据 · 摘要')
    output.clear()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 65, 0, 0))
    os.kill(process.pid, signal.SIGWINCH)
    collect()
    output.clear()
    press('\x1b[C')
    wait('焦点：关联依据')
    press('\t')
    wait('▸ 固定契约')
    action('人工选择')
    wait('填写选择理由')
    press('\x1b')  # Cancellation must leave ledger unchanged (asserted by caller).
    output.clear()
    press('q')
    wait('\x1b[?1049l')
    assert process.wait(timeout=10) == 0
    assert termios.tcgetattr(slave) == original
    print('REVIEW PTY PASS: historical contract, diff/basis, reports, 160/110/65 columns, selection cancellation, incremental keys, terminal restoration')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
