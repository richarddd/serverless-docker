import cachedir from "cachedir";
import { promisify } from "util";
import fs, { WriteStream } from "fs";
import path from "path";
import http from "http";
import { spawn, SpawnOptionsWithoutStdio } from "child_process";
import decompress from "decompress";

export const readdirAsync = promisify(fs.readdir);
export const rmdirAsync = promisify(fs.rmdir);
export const statAsync = promisify(fs.stat);
export const mkdirAsync = promisify(fs.mkdir);
export const writeFileAsync = promisify(fs.writeFile);
export const unlinkAsync = promisify(fs.unlink);
export const readFileAsync = promisify(fs.readFile);
export const existsAsync = (path: string) =>
  statAsync(path)
    .then(stats => stats.isDirectory() || stats.isFile())
    .catch(() => false);

export const convertHeader = (value: string) =>
  value.replace(/^[a-z]|-[a-z]/g, match => match.toUpperCase());

const contentAttachmentRegex = /attachment; filename="(.*)"/g;

export const downloadFile = async (
  url: string,
  dest: string,
  options: {
    extract?: boolean;
  }
) => {
  const targetUrl = new URL(url);
  let filename = targetUrl.pathname.split("/").reverse()[0] || "";
  await mkdirAsync(dest, {
    recursive: true
  });
  let file: WriteStream | undefined;
  let targetPath = "";
  await new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let contentDispositionHeader = response.headers["Content-Disposition"];
      if (contentDispositionHeader) {
        if (Array.isArray(contentDispositionHeader)) {
          contentDispositionHeader = contentDispositionHeader[0];
        }
        if (contentAttachmentRegex.test(contentDispositionHeader)) {
          const matchResults = contentAttachmentRegex.exec(
            contentDispositionHeader
          );
          filename = (matchResults && matchResults[1]) || filename;
        }
      }
      targetPath = path.join(dest, filename);
      file = fs.createWriteStream(path.join(dest, filename));

      response.pipe(file);
      file.on("finish", () => {
        if (file) {
          file.close();
        }
        resolve();
      });
    });
    request.on("error", () => {
      if (file) {
        file.close();
      }

      existsAsync(dest)
        .then(() => unlinkAsync(dest))
        .finally(reject);
    });
  });
  if (options.extract) {
    await decompress(targetPath, dest);
  }
};

export const cacheDir = path.join(cachedir("serverless"), "docker-proxy");
export const pathRegex: RegExp = /{\w+\+?}/g;

export const runProgram = async (
  command: string,
  args: string[],
  options?: {
    commandOptions?: SpawnOptionsWithoutStdio;
    print?: boolean | ((text: string, error?: boolean) => void);
  }
) =>
  new Promise<Buffer>((resolve, reject) => {
    //console.log(`Running: ${[command].concat(args || []).join(" ")}`);
    const spawnProcess = spawn(
      command,
      args,
      options && options.commandOptions
    );
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    const handlePrintOption = (data: any, error?: boolean) => {
      if (options && options.print) {
        if (typeof options.print === "boolean") {
          process[(error && "stderr") || "stdout"].write(data.toString());
        } else {
          options.print(data.toString(), error);
        }
      }
    };
    spawnProcess.stdout.on("data", data => {
      handlePrintOption(data);
      chunks.push(data);
    });
    spawnProcess.stderr.on("data", data => {
      handlePrintOption(data, true);
      errorChunks.push(data);
    });
    spawnProcess.on("error", error => {
      reject(error);
    });
    spawnProcess.on("close", code => {
      if (code === 1) {
        reject(Buffer.concat(errorChunks).toString());
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });

export const sleep = (time: number) =>
  new Promise(resolve => setTimeout(resolve, time * 1000));
