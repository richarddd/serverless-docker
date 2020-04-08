import { spawn, SpawnOptionsWithoutStdio } from "child_process";
import Koa from "koa";
import { promisify } from "util";
import Router from "@koa/router";
// import validate from "serverless/lib/plugins/aws/lib/validate";
import fs from "fs";
import fse from "fs-extra";
import path from "path";
import download from "download";
import cachedir from "cachedir";
import yaml from "js-yaml";
import fetch from "node-fetch";
import koaBody from "koa-body";
import decompress from "decompress";
import uuid from "uuid/v4";
import getPort from "get-port";
import {
  existsAsync,
  runProgram,
  readFileAsync,
  mkdirAsync,
  writeFileAsync,
  cacheDir,
  rmdirAsync,
  sleep,
  convertHeader,
  pathRegex,
  downloadFile,
  readdirAsync
} from "./utils";

const services = ["sns", "s3", "sqs"];
const regions = [
  "us-east-2",
  "us-east-1",
  "us-west-1",
  "us-west-2",
  "ap-east-1",
  "ap-south-1",
  "ap-northeast-3",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ca-central-1",
  "cn-north-1",
  "cn-northwest-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "me-south-1",
  "sa-east-1",
  "us-gov-east-1",
  "us-gov-west-1"
];

const externalServer = new Koa();
externalServer.use(koaBody());
const externalRouter = new Router();

const internalServer = new Koa();
internalServer.use(koaBody());
const internalRouter = new Router();

export type LambdaFunctionEvent = {
  http?: HttpEvent;
  sns?: SnsEvent;
  sqs?: SqsEvent;
  schedule?: ScheduleEvent;
};

export type LambdaFunction = {
  name: string;
  environment?: any;
  runtime?: string;
  memorySize?: string;
  handler: string;
  events?: LambdaFunctionEvent[];
};

type ScheduleEvent = {};

type SqsEvent = {};

type HttpEvent =
  | string
  | {
      method: string;
      path: string;
    };

type SnsEvent =
  | string
  | {
      arn: string;
      topicName?: string;
      filterPolicy?: Record<string, string[]>;
      displayName?: string;
      redrivePolicy?: {
        deadLetterTargetArn: string;
      };
    };

type RouteInfo = Record<
  string,
  {
    handler: string;
    routes: { method: string; path: string }[];
  }
>;

class DockerProxyPlugin {
  private serverless: any;
  private options: any;
  private resources: Record<string, any>;
  private functionPorts: Record<string, number>;
  private baseUrl: string;
  private endpointPort: number;
  private endpointUrl: string;

  hooks: Record<string, () => Promise<void> | void>;
  provider: any;
  commands: Record<string, any>;
  debugPorts: Record<string, number>;
  eventHandlers: Record<string, () => Promise<void> | void>;

  constructor(serverless: any, options: any) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider("aws");
    this.commands = {
      docker: {
        usage: "Uses docker to invoke serverless locally",
        lifecycleEvents: ["start"],
        commands: {
          logs: {
            lifecycleEvents: ["logs"]
          }
        }
      }
    };
    this.resources = {};
    this.functionPorts = {};
    this.debugPorts = {};
    this.endpointPort = 3000;
    this.endpointUrl = "";
    this.eventHandlers = {};

    //Object.assign(this, validate);

    this.hooks = {
      "docker:logs:logs": this.logs.bind(this),
      "docker:start": this.start.bind(this),
      "before:docker:start": this.package.bind(this)
      // "after:aws:common:validate:validate": this.generateRoutes.bind(this)
    };

    this.baseUrl = `http://localhost:${options.port || options.p || 3000}`;
  }

  logs = async () => {
    const composePath = path.join(
      ".serverless",
      "docker",
      "docker-compose.yml"
    );
    if (!(await existsAsync(composePath))) {
      throw new Error(
        `Docker not invoked! run "sls docker" and make sure its started before "sls docker logs"`
      );
    }
    await runProgram(
      "docker-compose",
      [
        "-f",
        path.join(".serverless", "docker", "docker-compose.yml"),
        "logs",
        "-f"
      ],
      { print: true }
    );
  };

  package = async () => {
    const statePath = path.join(this.getPackagePath(), "serverless-state.json");
    if (this.options["skip-package"] && (await existsAsync(statePath))) {
      const state = JSON.parse((await readFileAsync(statePath)).toString());
      this.resources =
        state.service.provider.compiledCloudFormationTemplate.Resources;
      return;
    }
    await this.serverless.pluginManager.spawn("package");
    this.resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
  };

  getConfiguredEnvVars = (lambdaFunction: LambdaFunction) => {
    const providerEnvVars = this.serverless.service.provider.environment || {};
    const functionEnvVars = lambdaFunction.environment || {};
    return { ...providerEnvVars, ...functionEnvVars };
  };

  getEnvVars = (lambdaFunction: LambdaFunction) => {
    const lambdaName = lambdaFunction.name;
    const runtime = this.getRuntime(lambdaFunction.runtime);
    const memorySize =
      Number(lambdaFunction.memorySize) ||
      Number(this.serverless.service.provider.memorySize) ||
      1024;

    const lambdaDefaultEnvVars: Record<string, any> = {
      LANG: "en_US.UTF-8",
      LD_LIBRARY_PATH:
        "/opt/lib:/var/lang/lib:/lib64:/usr/lib64:/var/runtime:/var/runtime/lib:/var/task:/var/task/lib", // eslint-disable-line max-len
      LAMBDA_TASK_ROOT: "/var/task",
      LAMBDA_RUNTIME_DIR: "/var/runtime",
      AWS_REGION: this.provider.getRegion(),
      AWS_DEFAULT_REGION: this.provider.getRegion(),
      AWS_LAMBDA_LOG_GROUP_NAME: this.provider.naming.getLogGroupName(
        lambdaName
      ),
      AWS_LAMBDA_LOG_STREAM_NAME:
        "2016/12/02/[$LATEST]f77ff5e4026c45bda9a9ebcec6bc9cad",
      AWS_LAMBDA_FUNCTION_NAME: lambdaName,
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: memorySize,
      AWS_LAMBDA_FUNCTION_VERSION: "$LATEST",
      NODE_PATH: "/var/runtime:/var/task:/var/runtime/node_modules",
      PATH: "/var/lang/bin:/usr/local/bin:/usr/bin/:/bin:/opt/bin"
    };

    const runtimeEnvVars: Record<string, any> = {};
    if (runtime.startsWith("node")) {
      runtimeEnvVars["NODE_OPTIONS"] = "--inspect=0.0.0.0";
    } else if (runtime.startsWith("java")) {
      runtimeEnvVars[
        "JAVA_OPTS"
      ] = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:${this.getDebugPort(
        runtime
      )}`;
    }

    const credentialEnvVars: Record<string, any> = {};
    const { cachedCredentials } = this.provider;
    if (cachedCredentials) {
      if (cachedCredentials.accessKeyId) {
        credentialEnvVars.AWS_ACCESS_KEY_ID = cachedCredentials.accessKeyId;
      }
      if (cachedCredentials.secretAccessKey) {
        credentialEnvVars.AWS_SECRET_ACCESS_KEY =
          cachedCredentials.secretAccessKey;
      }
      if (cachedCredentials.sessionToken) {
        credentialEnvVars.AWS_SESSION_TOKEN = cachedCredentials.sessionToken;
      }
    }

    // profile override from config
    const profileOverride = this.provider.getProfile();
    if (profileOverride) {
      lambdaDefaultEnvVars.AWS_PROFILE = profileOverride;
    }

    const configuredEnvVars = this.getConfiguredEnvVars(lambdaFunction);

    return {
      ...runtimeEnvVars,
      ...process.env,
      ...lambdaDefaultEnvVars,
      ...credentialEnvVars,
      ...configuredEnvVars
    } as Record<string, any>;
  };

  start = async () => {
    await this.startDocker();
    await this.loadEventHandlers();
    await this.generatePorts();
    await this.generateDockerCompose();
    await this.composeUp();
    await this.startServers();
  };

  loadEventHandlers = async () => {
    const eventHandlerFolder = "eventhandlers";
    const normalizedHandlerPath = path.join(__dirname, eventHandlerFolder);
    const handlers = await readdirAsync(normalizedHandlerPath);
    await Promise.all(
      handlers.map(async handlerFile => {
        const eventType = path.basename(handlerFile, path.extname(handlerFile));
        this.eventHandlers[eventType] = await import(handlerFile);
        this.serverless.cli.log(`Mapped event handler:  ${eventType}`);
      })
    );
  };

  generatePorts = async () => {
    this.endpointPort =
      this.options.endpointPort || this.options.e || (await getPort());
    this.endpointUrl = `http://host.docker.internal:${this.endpointPort}`;
    for (const functionName of this.serverless.service.getAllFunctions()) {
      this.functionPorts[functionName] = await getPort();
      this.debugPorts[functionName] = await getPort();
    }
  };

  generateLaunchConfiguration = async () => {
    if (!(await existsAsync("./vscode"))) {
      await mkdirAsync("./vscode");
    }

    const configurations: any[] = [];
    this.serverless.service
      .getAllFunctions()
      .forEach((functionName: string) => {
        const lambdaFunction = this.serverless.service.getFunction(
          functionName
        );
        const runtime = this.getRuntime(lambdaFunction.runtime);
        if (runtime.startsWith("node")) {
          configurations.push({
            name: "Docker: Attach to Node",
            type: "node",
            request: "attach",
            port: this.debugPorts[functionName],
            address: "localhost",
            localRoot: "${workspaceFolder}",
            remoteRoot: "/var/task",
            protocol: "inspector"
          });
        }
      });

    const launchPath = path.join(".vscode", "launch.json");
    let launchConfiguration: any = {};
    if (await existsAsync(launchPath)) {
      let contents = (await readFileAsync(launchPath)).toString();
      contents = contents.replace(/\/\/.*/g, "");
      launchConfiguration = JSON.parse(contents);
    }
    launchConfiguration.configurations = launchConfiguration.configurations.concat(
      configurations
    );
    await writeFileAsync(launchPath, JSON.stringify(launchConfiguration));
  };

  composeDown = async () => {
    await runProgram(
      "docker-compose",
      ["-f", path.join(".serverless", "docker", "docker-compose.yml"), "down"],
      { print: true }
    );
  };

  composeUp = async () => {
    this.serverless.cli.log("Running docker-compose");
    process.on("SIGINT", () => {
      this.composeDown()
        .catch()
        .then(() => {
          process.exit();
        });
    });
    process.on("EOF" as any, () => {
      this.composeDown()
        .catch()
        .then(() => {
          process.exit();
        });
    });
    await runProgram(
      "docker-compose",
      [
        "-f",
        path.join(".serverless", "docker", "docker-compose.yml"),
        "up",
        "-d"
      ],
      { print: true }
    );
  };

  checkDockerImage = async (imageName: string) => {
    try {
      const image = await runProgram("docker", ["images", "-q", imageName]);
      return image.toString() || false;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  getRuntime = (functionRuntime?: string) =>
    functionRuntime || this.serverless.service.provider.runtime || "nodejs12.x";

  generateHostFileOptions = () => {
    let hostFileActions = "RUN mkdir -p /etc";
    services.forEach(service => {
      regions.forEach(region => {
        hostFileActions += `RUN echo "${service}.${region}.amazonaws.com host.docker.internal" >> /etc/hosts`;
      });
    });

    return hostFileActions;
  };

  generateDockerfile = async (layerPaths: string[], runtime: string) => {
    const packagePath = this.getPackagePath();
    const dockerfileDirectory = path.join(packagePath, "docker", runtime);
    await mkdirAsync(dockerfileDirectory, {
      recursive: true
    });

    let exists = this.options.build
      ? false
      : await this.checkDockerImage(this.getDockerImageTagName(runtime));
    const dockerfilePath = path.join(dockerfileDirectory, "Dockerfile");
    const cachedDockerfilePath = path.join(
      cacheDir,
      "dockerfiles",
      runtime,
      "Dockerfile"
    );
    let dockerfile = `FROM lambci/lambda:${runtime}\n`;
    dockerfile += this.generateHostFileOptions();
    for (const layerPath of layerPaths) {
      this.serverless.cli.log(`- Adding layer: ${layerPath}`);
      dockerfile += `\nADD --chown=sbx_user1051:495 ${layerPath} /opt`;
    }
    if (!(await existsAsync(cachedDockerfilePath))) {
      exists = false;
    }

    if (exists) {
      const contents = (await readFileAsync(cachedDockerfilePath)).toString();
      exists = dockerfile === contents;
    }

    if (!exists) {
      this.serverless.cli.log(`Writing Dockerfile for ${runtime}...`);
      await writeFileAsync(dockerfilePath, dockerfile);
    }
    return {
      exists,
      dockerfilePath
    };
  };

  getPackagePath = () =>
    path.join(this.serverless.config.servicePath, ".serverless");

  getLayerPathsMap = async () => {
    const region = this.provider.getRegion();

    const layerNames = Object.keys(this.serverless.service.layers).reduce<
      Record<string, any>
    >((acc, layer) => {
      const logicalId = this.provider.naming.getLambdaLayerLogicalId(layer);
      acc[logicalId] = layer;
      return acc;
    }, {});

    const packagePath = this.getPackagePath();

    const pathsMap: Record<string, Record<string, any>> = {};

    const appendPathsMap = (key: string, value: string) => {
      pathsMap[key] = pathsMap[key] || {};
      pathsMap[key][value] = 1;
    };

    const fetchLayers: Record<
      string,
      {
        runtimes: string[];
        contentPath: string;
        cachePath: string;
        layerArn: string;
        layerVersion: string;
        name: string;
      }
    > = {};
    const unzipLayers: Record<
      string,
      {
        runtimes: string[];
        artifact: string;
      }
    > = {};
    this.serverless.service.getAllFunctions().map((functionName: string) => {
      const {
        layers: functionLayers = [],
        runtime: functionRuntime
      } = this.serverless.service.getFunction(functionName);
      const runtime = this.getRuntime(functionRuntime);

      for (const layer of [
        ...functionLayers,
        ...(this.serverless.service.provider.layers || [])
      ] || []) {
        if (layer.Ref) {
          const layerName = layerNames[layer.Ref];
          const layerObject = this.serverless.service.layers[layerName];
          if (layerObject.path) {
            appendPathsMap(runtime, layerObject.path);
          } else if (layerObject.package && layerObject.package.artifact) {
            unzipLayers[layerName] = unzipLayers[layerName] || {
              runtimes: [],
              artifact: layerObject.package.artifact
            };
            unzipLayers[layerName].runtimes.push(runtime);
          }
          continue;
        }
        const arnParts = layer.split(":");
        const layerArn = arnParts.slice(0, -1).join(":");
        const layerRegion = arnParts[3];
        const layerVersion = Number(arnParts.slice(-1)[0]);
        const contentPath = path.join(
          packagePath,
          "layers",
          arnParts[6],
          arnParts[7]
        );
        const cachePath = path.join(
          cacheDir,
          "layers",
          arnParts[6],
          arnParts[7]
        );
        if (layerRegion !== region) {
          throw new Error(
            `"${layer}" is not published in the provided region "${region}"`
          );
        }
        const cacheKey = `${contentPath}|||${cachePath}`;
        if (fetchLayers[cacheKey]) {
          continue;
        }
        fetchLayers[cacheKey] = fetchLayers[cacheKey] || {
          runtimes: [],
          contentPath,
          cachePath,
          layerArn,
          layerVersion,
          name: layer
        };
        fetchLayers[cacheKey].runtimes.push(runtime);
      }
    });

    await Promise.all([
      ...Object.entries(unzipLayers).map(async ([layerName, layer]) => {
        const { runtimes, artifact } = layer;
        const layerPath = path.join(
          ".serverless",
          "docker",
          "layers",
          layerName
        );
        await rmdirAsync(layerPath, { recursive: true });
        this.serverless.cli.log(`Decompressing ${layerName}...`);
        await decompress(artifact, layerPath);
        runtimes.forEach(runtime => {
          appendPathsMap(runtime, layerPath);
        });
      }),
      ...Object.entries(fetchLayers).map(async ([key, layer]) => {
        const {
          runtimes,
          contentPath,
          cachePath,
          name,
          layerArn,
          layerVersion
        } = layer;

        if (await existsAsync(contentPath)) {
          runtimes.forEach(runtime => {
            appendPathsMap(runtime, contentPath);
          });

          return;
        }

        if (!(await existsAsync(cachePath))) {
          this.serverless.cli.log(`Downloading layer ${name}...`);
          await mkdirAsync(path.join(cachePath), {
            recursive: true
          });
          const layerInfo = await this.provider.request(
            "Lambda",
            "getLayerVersion",
            {
              LayerName: layerArn,
              VersionNumber: layerVersion
            }
          );
          await downloadFile(layerInfo.Content.Location, cachePath, {
            extract: true
          });
        }

        await fse.copy(cachePath, contentPath);
        runtimes.forEach(runtime => {
          appendPathsMap(runtime, contentPath);
        });
      })
    ]);

    return Object.entries(pathsMap).reduce<Record<string, string[]>>(
      (acc, [key, runtime]) => {
        acc[key] = Object.keys(runtime);
        return acc;
      },
      {}
    );
  };

  getDockerImageTagName = (runtime: string) => `docker-proxy-${runtime}`;

  buildImage = async (dockerfilePath: string, runtime: string) => {
    const tagName = this.getDockerImageTagName(runtime);
    this.serverless.cli.log(`Building image: ${tagName}`);
    await runProgram(
      "docker",
      [
        "build",
        "-t",
        tagName,
        this.serverless.config.servicePath,
        "-f",
        dockerfilePath
      ],
      {
        print: true
      }
    );
  };

  extractArtifacts = async () => {
    const artifactPaths: Record<string, string> = {};
    await Promise.all(
      this.serverless.service
        .getAllFunctions()
        .map(async (functionName: string) => {
          const lambdaFunction = this.serverless.service.getFunction(
            functionName
          );
          const artifact =
            lambdaFunction.package && lambdaFunction.package.artifact;
          if (!artifact || artifact.endsWith(".jar")) {
            artifactPaths[functionName] = this.serverless.config.servicePath;
            return;
          }

          const destination = path.join(
            ".serverless",
            "docker",
            "artifacts",
            functionName
          );

          await decompress(artifact, destination);

          artifactPaths[functionName] = destination;
        })
    );
    return artifactPaths;
  };

  getDebugPort = (runtime: string) => {
    if (runtime.startsWith("node")) {
      return 9229;
    }
    if (runtime.startsWith("java")) {
      return 1044;
    }
    return -1;
  };

  getAllFunctions = () => this.serverless.service.getAllFunctions() as string[];

  generateDockerCompose = async () => {
    const packagePath = this.getPackagePath();

    await mkdirAsync(path.join(packagePath, "docker"), { recursive: true });
    const layerPathsMap = await this.getLayerPathsMap();

    await Promise.all(
      Object.keys(
        this.getAllFunctions()
          .map(
            (functionName: string) =>
              this.serverless.service.getFunction(
                functionName
              ) as LambdaFunction
          )
          .reduce<Record<string, number>>((acc, lambdaFunction) => {
            acc[this.getRuntime(lambdaFunction.runtime)] = 1;
            return acc;
          }, {})
      ).map(async runtime => {
        const { exists, dockerfilePath } = await this.generateDockerfile(
          layerPathsMap[runtime] || [],
          runtime
        );
        if (!exists) {
          await this.buildImage(dockerfilePath, runtime);
        }
      })
    );

    const artifactPaths = await this.extractArtifacts();

    const dockerCompose = {
      version: "3",
      services: this.getAllFunctions().reduce<
        Record<
          string,
          {
            image: string;
            command: string;
            volumes: string[];
            ports: string[];
            environment: Record<string, any>;
          }
        >
      >((acc, functionName) => {
        const lambdaFunction = this.serverless.service.getFunction(
          functionName
        );
        const artifactPath = artifactPaths[functionName];
        const { runtime: functionRuntime } = lambdaFunction;
        const runtime = this.getRuntime(functionRuntime);

        acc[functionName] = {
          image: this.getDockerImageTagName(runtime),
          command: lambdaFunction.handler,
          volumes: [`${artifactPath}:/var/task`],
          ports: [
            `${this.functionPorts[functionName]}:${9001}`,
            `${this.debugPorts[functionName]}:${this.getDebugPort(runtime)}`
          ],
          environment: {
            DOCKER_LAMBDA_STAY_OPEN: 1,
            ENDPOINT_URL_S3: this.endpointUrl,
            ...Object.entries(this.getEnvVars(lambdaFunction)).reduce<
              Record<string, any>
            >((acc, [key, value]) => {
              let printValue = value;
              if (typeof value === "object") {
                printValue = JSON.stringify(printValue);
              }
              acc[key] = printValue.toString();
              return acc;
            }, {})
          }
        };

        return acc;
      }, {})
    };

    await writeFileAsync(
      path.join(".serverless", "docker", "docker-compose.yml"),
      yaml.safeDump(dockerCompose, {
        lineWidth: Infinity
      })
    );
  };

  startDocker = async () => {
    this.serverless.cli.log(`Starting docker`);

    let startCommand: string[] = [];
    switch (process.platform) {
      case "darwin":
        startCommand = ["open", "/Applications/Docker.app"];
        break;
      default:
        startCommand = [
          "C:\\Program Files\\Docker\\Docker\\Docker for Windows.exe"
        ];
        break;
    }

    await runProgram(startCommand[0], startCommand.splice(1));
    while (true) {
      this.serverless.cli.log(`Waiting for docker to start`);

      try {
        await runProgram("docker", ["ps", "-q"], { print: true });
        break;
      } catch (e) {}
      await sleep(1);
    }
    this.serverless.cli.log(`Docker started`);
  };

  getProxyEvent = (
    ctx: Koa.ParameterizedContext,
    resource: string,
    pathParamName?: string
  ) => {
    const requestHeaders = ctx.headers as Record<string, any>;
    const response: Record<string, any> = {
      resource,
      path: ctx.path,
      httpMethod: ctx.method,
      headers: Object.entries(requestHeaders).reduce<Record<string, string>>(
        (acc, [key, value]) => {
          acc[convertHeader(key)] = value;
          return acc;
        },
        {}
      ),
      multiValueHeaders: Object.entries(requestHeaders).reduce<
        Record<string, string[]>
      >((acc, [key, value]) => {
        acc[convertHeader(key)] = [value];
        return acc;
      }, {}),
      requestContext: {
        accountId: "1234567890",
        resourceId: "localId",
        stage: "dev",
        requestId: uuid(),
        identity: {
          cognitoIdentityPoolId: null,
          accountId: null,
          cognitoIdentityId: null,
          caller: null,
          apiKey: null,
          sourceIp: "0.0.0.0",
          cognitoAuthenticationType: null,
          cognitoAuthenticationProvider: null,
          userArn: null,
          userAgent: ctx.get("user-agent"),
          user: null
        },
        resourcePath: resource,
        httpMethod: ctx.method,
        apiId: "localId"
      },
      body: ctx.request.body,
      isBase64Encoded: false
    };

    if (ctx.request.query) {
      const requestQuery: Record<string, any> = ctx.request.query;
      response.queryStringParameters = Object.entries(requestQuery).reduce<
        Record<string, string>
      >((acc, [key, value]) => {
        acc[key] = (Array.isArray(value) && value[value.length - 1]) || value;
        return acc;
      }, {});
      response.multiValueQueryStringParameters = Object.entries(
        requestQuery
      ).reduce<Record<string, string[]>>((acc, [key, value]) => {
        acc[key] = (Array.isArray(value) && value) || [value];
        return acc;
      }, {});
    }
    if (pathParamName) {
      response.pathParameters = {
        [pathParamName]: ctx.path.substring(resource.indexOf("{"))
      };
    }
    return JSON.stringify(response);
  };

  configureHttpEvent = (
    functionName: string,
    handler: string,
    httpEvent: HttpEvent,
    routeInfo: RouteInfo
  ) => {
    let method = "GET";
    let path = "/";
    let originalPath = "";
    let pathParamName: string | undefined = undefined;
    if (typeof httpEvent === "string") {
      const spaceIndex = httpEvent.indexOf(" ");
      method = httpEvent.substring(0, spaceIndex).toLowerCase();
      path = httpEvent.substring(spaceIndex + 1, httpEvent.length);
      originalPath = path;
    } else {
      method = httpEvent.method.toLowerCase();
      originalPath = httpEvent.path;
      path = httpEvent.path;
    }

    path = path.replace(pathRegex, pathParam => {
      const paramValue = pathParam.slice(1, -1);
      if (paramValue.endsWith("+")) {
        pathParamName = paramValue.slice(0, -1);
        return "*";
      }
      return `:${paramValue}`;
    });

    if (!path.startsWith("/")) {
      path = `/${path}`;
      originalPath = `/${originalPath}`;
    }

    const routeMethod:
      | typeof externalRouter.all
      | undefined = (externalRouter as any)[method];
    if (routeMethod) {
      if (!routeInfo[functionName]) {
        routeInfo[functionName] = {
          handler,
          routes: []
        };
      }
      routeInfo[functionName].routes.push({ method, path: originalPath });

      routeMethod(path, async (ctx, next) => {
        try {
          const res = await fetch(
            `http://localhost:${this.functionPorts[functionName]}/2015-03-31/functions/${functionName}/invocations`,
            {
              method: "POST",
              body: this.getProxyEvent(ctx, originalPath, pathParamName)
            }
          );
          const proxyResponse = await res.json();

          ctx.response.status = proxyResponse.statusCode || 200;
          ctx.body = proxyResponse.body;
        } catch (error) {
          console.error(error);
          ctx.set("Content-Type", "application/json");
          ctx.body = { message: "Internal server error" };
        }
      });
    } else {
      throw new Error(`"${method}" is not a valid HTTP method`);
    }
  };

  configuresnsEvent(functionName: string, handler: string, snsEvent: SnsEvent) {
    if (typeof snsEvent === "string") {
    } else if (snsEvent.arn) {
      JSON.stringify(snsEvent.arn);
    } else {
    }
  }

  startServers = () => {
    this.serverless.cli.log(`Starting servers`);

    const routeInfo: RouteInfo = {};

    for (const functionName of this.serverless.service.getAllFunctions()) {
      const lambdaFunction = this.serverless.service.getFunction(
        functionName
      ) as LambdaFunction;

      const events = lambdaFunction.events || [];
      for (const eventCollection of events) {
        for (const [event, eventdata] of Object.entries(eventCollection)) {
        }
      }

      // (events || []).forEach(({ http: httpEvent, sns: snsEvent }) => {
      //   if (httpEvent) {
      //     this.configureHttpEvent(
      //       functionName,
      //       lambdaFunction.handler,
      //       httpEvent,
      //       routeInfo
      //     );
      //   }
      //   if (snsEvent) {
      //     this.configuresnsEvent(
      //       functionName,
      //       lambdaFunction.handler,
      //       snsEvent
      //     );
      //   }
      // });
    }

    externalRouter.get("/*", (ctx, next) => {
      const message = "Not found";
      const status = 404;
      ctx.body = JSON.stringify({ message, status });
      ctx.status = status;
    });

    externalServer
      .use(externalRouter.routes())
      .use(externalRouter.allowedMethods());

    this.serverless.cli.log(
      `Routes: \n${Object.entries(routeInfo)
        .map(
          ([name, { routes, handler }]) =>
            `${" ".repeat(3)}${name} → ${handler}:\n${routes.map(
              ({ method, path }) =>
                `${" ".repeat(6)}${method}: ${this.baseUrl}${path}`
            )}\n`
        )
        .join("\n")}`
    );

    externalServer.listen(3000);

    internalRouter.get("/*", (ctx, next) => {
      ctx.status = 500;
    });
    internalServer.use(async (ctx, next) => {
      const { arn } = ctx.request.body;
      //sdkWrappers[arn];
      //console.log("ctx", ctx);
      console.log("body", ctx.request.body);
      await next();
    });
    internalServer.listen(443);

    process.openStdin();

    process.openStdin().addListener("data", line => {
      switch (line.toString().trim()) {
        case "ports": {
          console.log(
            `Debug ports:\n\t${Object.entries(this.debugPorts)
              .map(
                ([functionName, port]) =>
                  `${port.toString().padEnd(5, " ")} → ${functionName}`
              )
              .join("\n\t")}`
          );
        }
      }
    });

    this.serverless.cli.log(`Server serving requests at ${this.baseUrl}`);
  };

  generateRoutes() {
    //this.serverless.cli.log(`Generating routes...`);
  }
}
module.exports = DockerProxyPlugin;
