import { ethers } from "ethers";
import axios from "axios";

const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const OPPORTUNITY_URL = process.env.OPPORTUNITY_URL ?? "https://content-platform.local/api/opportunities/chibi-peko";
const FALLBACK = { score: 60, apy: 0.0, capital: 0 };

export class ChibiPekoLandingWindowAgent {
  async execute(): Promise<{ success: boolean; profitUsdc?: bigint }> {
    try {
      const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
      const network = await provider.getNetwork();
      if (network.chainId !== 8453n) {
        return { success: false };
      }

      let opportunity = FALLBACK;
      try {
        const response = await axios.get<typeof FALLBACK>(OPPORTUNITY_URL, { timeout: 5000 });
        opportunity = response.data;
      } catch (err) {
        console.warn("Using fallback opportunity data:", err);
      }

      const { score, apy, capital } = opportunity;
      const profitUsdc = BigInt(Math.floor((capital * apy / 100) * 10 ** 6));
      if (score < 80 || capital <= 0 || apy <= 0 || profitUsdc <= 0n) {
        return { success: false };
      }

      return { success: true, profitUsdc };
    } catch (error) {
      console.error("Chibi-Peko Landing Window Agent failed:", error);
      return { success: false };
    }
  }
}
