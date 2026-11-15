/** 终端录制器：从 xterm 输入流提取按回车提交的命令，忽略方向键等控制序列。 */

const ESC = "\u001b";
const CARRIAGE_RETURN = "\r";
const LINE_FEED = "\n";
const BACKSPACE = "\b";
const DELETE = "\u007f";
const CANCEL = "\u0003";
const END_OF_TEXT = "\u0004";
const KILL_LINE = "\u0015";

function isFinalEscapeCharacter(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

export class TerminalInputRecorder {
  private buffer = "";

  reset(): void {
    this.buffer = "";
  }

  /** 消费一段 xterm onData；返回本段中已经由回车完成的新命令。 */
  consume(data: string): string[] {
    const completed: string[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index];
      const code = data.charCodeAt(index);

      if (char === ESC) {
        index = this.skipEscapeSequence(data, index);
        continue;
      }
      if (char === CARRIAGE_RETURN || char === LINE_FEED) {
        // Windows 风格的 CRLF 只视为一次回车
        if (char === CARRIAGE_RETURN && data[index + 1] === LINE_FEED) index += 1;
        const command = this.flush();
        if (command) completed.push(command);
        continue;
      }
      if (char === BACKSPACE || char === DELETE) {
        // 使用码点删除，避免把 emoji 等代理对删成半个字符
        const characters = Array.from(this.buffer);
        characters.pop();
        this.buffer = characters.join("");
        continue;
      }
      if (char === CANCEL || char === END_OF_TEXT || char === KILL_LINE) {
        this.buffer = "";
        continue;
      }
      if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) this.buffer += char;
    }
    return completed;
  }

  private skipEscapeSequence(data: string, start: number): number {
    const next = start + 1;
    if (next >= data.length || (data[next] !== "[" && data[next] !== "O")) return next;
    let index = next + 1;
    while (index < data.length && !isFinalEscapeCharacter(data.charCodeAt(index))) index += 1;
    return Math.min(index, data.length - 1);
  }

  private flush(): string | null {
    const command = this.buffer.trim();
    this.buffer = "";
    return command || null;
  }
}
