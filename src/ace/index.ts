import { config } from "../config.ts";
import { AceMusicProvider } from "./acemusic.ts";
import { SelfHostedProvider } from "./selfhosted.ts";
import type { MusicProvider } from "./provider.ts";

let cached: MusicProvider | null = null;

export function getProvider(): MusicProvider {
  if (cached) return cached;
  cached = config.provider === "selfhosted" ? new SelfHostedProvider() : new AceMusicProvider();
  return cached;
}

export type { MusicProvider } from "./provider.ts";
export { ProviderError } from "./provider.ts";
