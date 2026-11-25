export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const loggerSilencioso: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
