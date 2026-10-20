declare module "pi-proof-openai-oauth" {
  export const openaiChatGPTOAuth: import("@earendil-works/pi-ai").OAuthAuth;
}
declare module "pi-proof-auth" {
  export function verifyAccessOwner(token: string, config: { issuer: string; audience: string; subjectHash: string }): Promise<true>;
}
