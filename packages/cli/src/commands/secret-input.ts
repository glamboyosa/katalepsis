/** Reads all of stdin, for `echo "$KEY" | katalepsis auth set openai` in scripts. */
const readPiped = async (): Promise<string> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
};

/** Prompts on stderr and reads a line from the terminal without echoing it. */
const readHidden = (prompt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    const finish = (error: Error | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (error === null) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish(null);
        if (character === "\u0003") return finish(new Error("Cancelled."));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });

/** Reads a secret from the terminal without echo, or from piped stdin. */
export const readSecret = async (prompt: string): Promise<string> =>
  (process.stdin.isTTY ? await readHidden(prompt) : await readPiped()).trim();
