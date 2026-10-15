import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";
import { windowsProtect } from "./openai-settings.mjs";

export const MAX_QUESTION_LENGTH = 64_000;
export const QUESTION_BODY_LIMIT = 512_000;
const unavailable = () => new AppError("QUESTION_SETTINGS_UNAVAILABLE", "The saved question could not be opened or saved. You can replace or forget it; your AI key and model are unchanged.", 503);

export function validateQuestion(question, { allowEmpty = false } = {}) {
  if (typeof question !== "string" || question.length > MAX_QUESTION_LENGTH || (!allowEmpty && !question.trim())) {
    throw new AppError("INVALID_QUESTION", "Enter a question of up to 64,000 characters.");
  }
  return question;
}

// Separate from credentials so saving or forgetting a question cannot alter a key.
export function createQuestionSettingsStore({ directory = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "IBKROptionsAdvisor"), protect = windowsProtect } = {}) {
  const filename = directory && path.join(directory, "question.v1.dpapi");
  let pending = Promise.resolve();
  const serialized = action => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };
  const result = question => ({ saved: question !== null, question: question ?? "", max_length: MAX_QUESTION_LENGTH });
  return {
    read: () => serialized(async () => {
      if (!filename) throw unavailable();
      let plaintext;
      try {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.size > QUESTION_BODY_LIMIT) throw unavailable();
        plaintext = await protect("unprotect", await fs.readFile(filename), QUESTION_BODY_LIMIT);
        const value = JSON.parse(plaintext.toString("utf8"));
        if (value.version !== 1) throw unavailable();
        return result(validateQuestion(value.question));
      } catch (error) {
        if (error.code === "ENOENT") return result(null);
        throw unavailable();
      } finally { plaintext?.fill(0); }
    }),
    save: input => serialized(async () => {
      if (!input || Array.isArray(input) || Object.keys(input).some(key => key !== "question")) {
        throw new AppError("INVALID_SETTINGS", "Only the question can be saved here.");
      }
      const question = validateQuestion(input.question);
      if (!filename) throw unavailable();
      const plaintext = Buffer.from(JSON.stringify({ version: 1, question }));
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        const encrypted = await protect("protect", plaintext, QUESTION_BODY_LIMIT);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, filename);
        return result(question);
      } catch { throw unavailable(); }
      finally { plaintext.fill(0); await fs.unlink(temporary).catch(() => {}); }
    }),
    forget: () => serialized(async () => {
      if (!filename) throw unavailable();
      try { await fs.unlink(filename); }
      catch (error) { if (error.code !== "ENOENT") throw unavailable(); }
      return result(null);
    })
  };
}
