"""Walk the new Eval workbench paths in a real terminal against a temporary CLI ledger."""
import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time


class Terminal:
    def __init__(self, rows, columns, command):
        self.master, slave = os.openpty()
        self.original = termios.tcgetattr(slave)
        self.slave = slave
        self.resize(rows, columns, notify=False)
        self.process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        self.output = bytearray()

    def collect(self, seconds=.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], .03)[0]:
                self.output.extend(os.read(self.master, 65536))

    def settle(self, floor=.05, quiet=.12, cap=1.0):
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
            if select.select([self.master], [], [], .02)[0]:
                self.output.extend(os.read(self.master, 65536))
                last = time.monotonic()
                continue
            if now - start >= floor and now - last >= quiet:
                return

    def wait(self, value, timeout=30):
        deadline = time.monotonic() + timeout
        while value.encode() not in self.output and time.monotonic() < deadline:
            self.collect(.1)
            if self.process.poll() is not None:
                break
        assert value.encode() in self.output, 'Missing ' + value + '\n' + self.output.decode(errors='replace')[-5000:]
        self.settle()

    def press(self, keys):
        self.output.clear()
        os.write(self.master, keys.encode())
        self.settle()

    def down(self, count=1):
        for _ in range(count):
            self.press('\x1b[B')

    def resize(self, rows, columns, notify=True):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        if notify:
            os.kill(self.process.pid, signal.SIGWINCH)
            self.settle()
            assert self.process.poll() is None, 'Resize crashed'

    def select_text(self, value):
        self.press('/')
        self.press(value)
        deadline = time.monotonic() + 5
        while ('筛选：' + value).encode() not in self.output and time.monotonic() < deadline:
            self.collect(.1)
        assert ('筛选：' + value).encode() in self.output, 'Search input missing: ' + self.output.decode(errors='replace')[-2000:]
        self.press('\r')
        self.settle()
        self.press('\r')

    def inspect_body(self, value):
        self.press('\t')
        for _ in range(100):
            if value.encode() in self.output:
                return
            self.press('\x1b[6~')
        assert value.encode() in self.output, 'Body section missing: ' + value + '\n' + self.output.decode(errors='replace')[-2000:]

    def close(self):
        if self.process.poll() is None:
            self.press('q')
            self.wait('\x1b[?1049l')
            assert self.process.wait(timeout=10) == 0
        assert termios.tcgetattr(self.slave) == self.original, 'Terminal attributes not restored'
        os.close(self.master)
        os.close(self.slave)


qa_search, grader_search, version, initial_tasks, rows, columns, *command = sys.argv[1:]
assert command, 'TUI command required'
version, initial_tasks, rows, columns = map(int, (version, initial_tasks, rows, columns))
terminal = Terminal(rows, columns, command)
try:
    # A title/quiet interval alone does not acknowledge asynchronous input readiness.
    terminal.wait('有据 Grounds · 评测工作台')
    terminal.wait('q 退出')
    terminal.press('\r')
    terminal.wait('有据 Grounds · 评测工作台 · 题集与评分')
    terminal.down()
    terminal.press('\r')
    terminal.wait('有据 Grounds · 题集 · v' + str(version))
    terminal.press('\r')
    terminal.wait('题集编排')
    terminal.down(initial_tasks)
    terminal.press('\r')
    terminal.wait('选择任务类型')
    terminal.press('\r')
    terminal.wait('选择 QA 与版本')
    terminal.select_text(qa_search)
    terminal.wait('选择精确')
    terminal.down()
    terminal.press('\r')
    terminal.wait('题集编排')
    terminal.down(initial_tasks)
    terminal.press('\r')
    terminal.wait('编排 ·')
    terminal.down(2)
    terminal.press('\r')
    terminal.wait('匹配评分规则')
    terminal.select_text(grader_search)
    terminal.wait('选择精确')
    terminal.press('\r')
    terminal.wait('确认评分绑定')
    terminal.press('\r')
    terminal.wait('题集编排')
    terminal.down(initial_tasks + 3)
    terminal.press('\r')
    terminal.wait('发布确认')
    terminal.inspect_body('待发布内容')
    terminal.press('\t')
    terminal.press('\r')
    terminal.wait('已发布题集')
    terminal.press('\r')
    terminal.wait('有据 Grounds · 题集 · v' + str(version + 1))
    terminal.close()
finally:
    if terminal.process.poll() is None:
        os.killpg(terminal.process.pid, signal.SIGKILL)
        terminal.process.wait()
        os.close(terminal.master)
        os.close(terminal.slave)

terminal = Terminal(rows, columns, command)
try:
    terminal.wait('有据 Grounds · 评测工作台')
    terminal.wait('q 退出')
    terminal.down()
    terminal.wait('› ☐')
    terminal.press(' ')
    terminal.wait('› ☑')
    terminal.down()
    terminal.wait('› ☐')
    terminal.press(' ')
    terminal.wait('› ☑')
    terminal.press('c')
    terminal.wait('多组实验对照')
    terminal.press('d')
    terminal.wait('选择基线实验')
    terminal.press('\r')
    terminal.wait('选择对照实验')
    terminal.press('\r')
    terminal.wait('实验差异')
    terminal.press(':')
    terminal.wait('当前操作')
    terminal.press('\r')
    terminal.wait('按变化筛选')
    terminal.down(2)
    terminal.press('\r')
    terminal.wait('退步')
    terminal.press('\r')
    terminal.wait('同题并排')
    terminal.press('\x1b[C')
    terminal.wait('对照')
    terminal.press('\x1b[D')
    terminal.wait('基线')
    terminal.press(':')
    terminal.wait('当前操作')
    terminal.down(3)
    terminal.press('\r')
    terminal.wait('逐题审阅')
    terminal.press(':')
    terminal.wait('当前操作')
    terminal.down(3)
    terminal.press('\r')
    terminal.wait('tools.jsonl')
    terminal.close()
    print(f'WORKBENCH PTY PASS: suite v{version + 1} and regression evidence at {columns}x{rows}')
finally:
    if terminal.process.poll() is None:
        os.killpg(terminal.process.pid, signal.SIGKILL)
        terminal.process.wait()
        os.close(terminal.master)
        os.close(terminal.slave)
