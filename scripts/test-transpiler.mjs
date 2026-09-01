// Test script for the transpiler fixes

const testCode = `import axios from 'axios';
import { ethers } from 'ethers';

export class CoinbasePriceApiAgent {
  private provider: ethers.Provider;
  private serviceUrl: string;

  constructor() {
    this.provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
    this.serviceUrl = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
  }

  async execute(): Promise<{ success: boolean; profitUsdc?: bigint }> {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      console.log(\`Current Base block: \${blockNumber}\`);

      const response = await axios.get(this.serviceUrl);
      const ethPrice: string = response.data?.data?.amount;
      console.log(\`Coinbase ETH spot price: $\${ethPrice}\`);

      return { success: true, profitUsdc: 0n };
    } catch (error: any) {
      console.error('Agent execution failed:', error.message || error);
      return { success: false };
    }
  }
}`;

function transpileBasic(code) {
  let result = code;

  // 1. Remove type-only imports (import type { ... })
  result = result.replace(/import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?/g, '');
  result = result.replace(/import\s+type\s+\w+\s+from\s+['"][^'"]+['"];?/g, '');

  // 2. Remove 'type' from mixed imports (import { type Foo, Bar })
  result = result.replace(/,\s*type\s+\w+/g, '');
  result = result.replace(/{\s*type\s+\w+\s*,/g, '{');
  result = result.replace(/,\s*type\s+\w+\s*}/g, '}');
  result = result.replace(/{\s*type\s+\w+\s*}/g, '{}');

  // 3. Remove interface and type definitions entirely
  result = result.replace(/^\s*interface\s+\w+[^{]*\{[\s\S]*?\n\s*\}/gm, '');
  result = result.replace(/^\s*type\s+\w+\s*=\s*[^;]+;/gm, '');

  // 4. CRITICAL: Remove class property declarations with types
  // 4a. With modifier: "  private provider: ethers.Provider;"
  result = result.replace(/^(\s*)(private|public|protected|readonly)\s+(\w+)\s*:\s*[^;=\n]+;\s*$/gm, '');
  
  // 4b. Multiple modifiers: "  private readonly provider: ethers.Provider;"
  result = result.replace(/^(\s*)(private|public|protected)\s+(readonly\s+)?(\w+)\s*:\s*[^;=\n]+;\s*$/gm, '');
  
  // 4c. Without modifier but with type (inside class): "  provider: ethers.Provider;"
  result = result.replace(/^(\s{2,})(\w+)\s*:\s*\w+(?:\.\w+)*(?:<[^>]*>)?(?:\[\])?\s*;\s*$/gm, '');

  // 5. Remove access modifiers from methods (private, public, protected, readonly)
  result = result.replace(/\b(private|protected|public|readonly)\s+(?=\w+\s*[\(=])/g, '');
  result = result.replace(/\b(private|protected|public|readonly)\s+(?=async\s+\w+)/g, '');

  // 6. Remove constructor parameter properties (constructor(private foo: string))
  result = result.replace(/constructor\s*\(([^)]*)\)/g, (match, params) => {
    const cleaned = params
      .replace(/\b(private|public|protected|readonly)\s+/g, '')
      .replace(/:\s*[^,)]+/g, '');
    return `constructor(${cleaned})`;
  });

  // 7. Remove return type annotations FIRST (before parameter types)
  // Handle complex Promise return types: ): Promise<{ success: boolean; ... }> {
  result = result.replace(/\)\s*:\s*Promise<\{[^}]+\}>\s*\{/g, ') {');
  result = result.replace(/\)\s*:\s*Promise<[^>]+>\s*\{/g, ') {');
  result = result.replace(/\)\s*:\s*Promise<[^>]+>\s*=>/g, ') =>');
  // Handle simple return types: ): string {
  result = result.replace(/\)\s*:\s*\w+(?:\[\])?\s*\{/g, ') {');
  result = result.replace(/\)\s*:\s*\w+(?:\[\])?\s*=>/g, ') =>');

  // 8. Remove type annotations from variable declarations 
  // const onchainKey: string = ... -> const onchainKey = ...
  result = result.replace(/(\b(?:const|let|var)\s+\w+)\s*:\s*\w+(?:\.\w+)*(?:<[^>]*>)?(?:\[\])?\s*=/g, '$1 =');

  // 8b. Remove type annotations from catch clause: catch (error: any) -> catch (error)
  result = result.replace(/catch\s*\(\s*(\w+)\s*:\s*\w+\s*\)/g, 'catch ($1)');

  // 9. Remove 'as Type' casts CAREFULLY - don't eat nearby content
  // (error as Error) -> (error)
  result = result.replace(/\(\s*(\w+)\s+as\s+\w+(?:\.\w+)*\s*\)/g, '($1)');
  // value as Type (without parens, end of expression)
  result = result.replace(/(\w+)\s+as\s+\w+(?:\.\w+)*(?=\s*[;,\)])/g, '$1');

  // 10. Remove generic type parameters from class/function/method
  result = result.replace(/(\bclass\s+\w+)\s*<[^>]+>/g, '$1');
  result = result.replace(/(\bfunction\s+\w+)\s*<[^>]+>/g, '$1');

  // 11. Remove non-null assertions (!)
  result = result.replace(/(\w+)!/g, '$1');

  // 12. Remove implements clauses
  result = result.replace(/(\bclass\s+\w+)\s+implements\s+[^{]+\{/g, '$1 {');

  // 13. Remove extends with generics
  result = result.replace(/(\bextends\s+\w+)\s*<[^>]+>/g, '$1');

  // 14. Clean up empty import statements
  result = result.replace(/import\s*\{\s*\}\s*from\s*['"][^'"]+['"];?/g, '');

  // 15. Remove abstract keyword
  result = result.replace(/\babstract\s+/g, '');

  // 16. Remove declare statements
  result = result.replace(/^\s*declare\s+[^;]+;/gm, '');

  // 17. Clean up multiple blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

console.log('=== Input TypeScript ===');
console.log(testCode);
console.log('\n=== Output JavaScript ===');
const output = transpileBasic(testCode);
console.log(output);

// Try to evaluate it (syntax check)
console.log('\n=== Syntax Check ===');
try {
  // Can't actually eval ESM modules but we can check for obvious syntax issues
  const hasColonType = output.match(/\w+\s*:\s*(string|number|boolean|ethers\.\w+|Promise)/);
  if (hasColonType) {
    console.log('❌ Still has type annotation:', hasColonType[0]);
  } else {
    console.log('✅ No obvious type annotations found');
  }
  
  // Check for class property declarations
  const hasPropertyDecl = output.match(/^\s*(private|public|protected)\s+\w+\s*:/m);
  if (hasPropertyDecl) {
    console.log('❌ Still has property declaration:', hasPropertyDecl[0]);
  } else {
    console.log('✅ No property declarations with modifiers');
  }
  
  // Check for isolated "identifier: Type;" lines
  const hasIsolatedType = output.match(/^\s+\w+\s*:\s*\w+(\.\w+)*\s*;$/m);
  if (hasIsolatedType) {
    console.log('❌ Still has isolated type line:', hasIsolatedType[0]);
  } else {
    console.log('✅ No isolated type declaration lines');
  }
  
} catch (e) {
  console.log('❌ Syntax error:', e.message);
}
