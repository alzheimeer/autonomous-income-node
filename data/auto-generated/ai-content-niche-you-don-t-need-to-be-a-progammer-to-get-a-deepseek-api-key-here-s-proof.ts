import { ethers } from 'ethers';
import axios from 'axios';

const ABI = [
  'function publishArticle(string memory contentHash) external returns (uint256 reward)',
  'event ArticlePublished(address indexed author, string contentHash, uint256 reward)',
];

export class AIContentAgent {
  async execute(): Promise<{ success: boolean; profitUsdc?: bigint }> {
    try {
      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
      const contract = new ethers.Contract(
        process.env.CONTRACT_ADDRESS!,
        ABI,
        signer
      );

      // Generate article content via DeepSeek API
      const prompt =
        "Write a Medium article titled 'You Don’t Need to Be a Programmer to Get a DeepSeek API Key — Here’s Proof'.";
      const deepseekKey = process.env.DEEPSEEK_API_KEY;
      if (!deepseekKey) throw new Error('Missing DEEPSEEK_API_KEY');

      const response = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
        },
        { headers: { Authorization: `Bearer ${deepseekKey}` } }
      );

      const articleText: string = response.data.choices[0].message.content;
      if (!articleText || articleText.length < 100) {
        throw new Error('Generated article too short');
      }

      // Compute content hash (simple hash for example)
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes(articleText));

      // Submit to Base smart contract
      const tx = await contract.publishArticle(contentHash);
      const receipt = await tx.wait();

      // Parse reward from event
      const eventLog = receipt.logs.find(
        (log: ethers.Log) => log.topics[0] === contract.interface.getEvent('ArticlePublished')!.topicHash
      );
      if (!eventLog) throw new Error('Publication event not found');

      const parsedLog = contract.interface.parseLog({
        topics: eventLog.topics as string[],
        data: eventLog.data,
      })!;
      const reward: bigint = parsedLog.args.reward;

      return { success: true, profitUsdc: reward };
    } catch (error: any) {
      console.error(`Agent execution failed: ${error.message}`);
      return { success: false };
    }
  }
}
