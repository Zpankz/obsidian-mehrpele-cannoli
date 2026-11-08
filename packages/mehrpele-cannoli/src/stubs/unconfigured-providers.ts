// The companion always supplies a configured provider model. It never uses the SDK's
// implicit cloud gateway or its separate OpenRouter client (compatible endpoints use
// the user's configured OpenAI-compatible transport instead).
const unavailable = () => { throw new Error("Choose a provider in Mehrpele Flows settings"); };
export const createOpenRouter = () => unavailable;
export const createGateway = () => Object.assign(unavailable, { languageModel: unavailable });
export const gateway = createGateway();
export class GatewayError extends Error {
  static isInstance(error: unknown): boolean { return error instanceof this; }
}
export class GatewayAuthenticationError extends GatewayError {}
