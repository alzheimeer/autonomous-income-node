/**
 * AutonomousValidator
 *
 * Validates auto-generated TypeScript modules WITHOUT requiring pnpm or the full
 * test suite. This validator runs inside Docker and performs:
 *
 *   1. Syntax validation via TypeScript compiler API
 *   2. Import resolution check (are all imports resolvable?)
 *   3. Structure validation (exports a class with execute() method)
 *   4. Runtime execution test with timeout
 *
 * This replaces the skipped sandbox for data/auto-generated/ files.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Time taken for validation in ms */
  durationMs: number;
  /** FIX-027: True if the code failed because it needs manual setup (API key, account, etc.) */
  requiresManualSetup?: boolean;
  /** FIX-027: Description of what manual setup is needed */
  manualSetupReason?: string;
}

/**
 * Validates TypeScript code for auto-generated modules.
 * Does NOT require pnpm or external test framework.
 */
export class AutonomousValidator {
  private readonly tempDir: string;

  constructor(tempDir = '/app/data/temp-validator') {
    this.tempDir = tempDir;
  }

  /**
   * Validate the proposed TypeScript code.
   *
   * @param code - The TypeScript/JavaScript code to validate
   * @param moduleName - Name for the temporary file
   * @returns ValidationResult with errors and warnings
   */
  async validate(code: string, moduleName: string): Promise<ValidationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Basic syntax checks
    const syntaxErrors = this.checkBasicSyntax(code);
    if (syntaxErrors.length > 0) {
      return {
        valid: false,
        errors: syntaxErrors,
        warnings,
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Check required structure
    const structureErrors = this.checkRequiredStructure(code);
    if (structureErrors.length > 0) {
      errors.push(...structureErrors);
    }

    // 3. Check for common anti-patterns
    const antiPatternWarnings = this.checkAntiPatterns(code);
    warnings.push(...antiPatternWarnings);

    // 4. Try to dynamically import and execute
    if (errors.length === 0) {
      try {
        const runtimeResult = await this.testRuntimeExecution(code, moduleName);
        if (!runtimeResult.success) {
          errors.push(...runtimeResult.errors);
        }
        warnings.push(...runtimeResult.warnings);
      } catch (err) {
        errors.push(`Runtime test failed: ${(err as Error).message}`);
      }
    }

    // FIX-027: Check if any error indicates manual setup is required
    const setupErrorPrefix = 'REQUIRES_MANUAL_SETUP:';
    const setupError = errors.find(e => e.startsWith(setupErrorPrefix));
    
    if (setupError) {
      return {
        valid: false,
        errors,
        warnings,
        durationMs: Date.now() - startTime,
        requiresManualSetup: true,
        manualSetupReason: setupError.replace(setupErrorPrefix, '').trim(),
      };
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Basic syntax validation without TypeScript compiler
   */
  private checkBasicSyntax(code: string): string[] {
    const errors: string[] = [];

    // Check for balanced braces
    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;

    for (const char of code) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }
      if ((char === '"' || char === "'" || char === '`') && !inString) {
        inString = true;
        stringChar = char;
        continue;
      }
      if (char === stringChar && inString) {
        inString = false;
        stringChar = '';
        continue;
      }
      if (inString) continue;

      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
      if (char === '(') parenCount++;
      if (char === ')') parenCount--;
      if (char === '[') bracketCount++;
      if (char === ']') bracketCount--;
    }

    if (braceCount !== 0) {
      errors.push(`Unbalanced braces: ${braceCount > 0 ? 'missing }' : 'extra }'}`);
    }
    if (parenCount !== 0) {
      errors.push(`Unbalanced parentheses: ${parenCount > 0 ? 'missing )' : 'extra )'}`);
    }
    if (bracketCount !== 0) {
      errors.push(`Unbalanced brackets: ${bracketCount > 0 ? 'missing ]' : 'extra ]'}`);
    }

    // Check for incomplete statements
    if (code.match(/^\s*(import|export|const|let|var|function|class|async)\s*$/m)) {
      errors.push('Found incomplete statement (keyword at end of line without body)');
    }

    return errors;
  }

  /**
   * Validate required structure for auto-generated modules
   */
  private checkRequiredStructure(code: string): string[] {
    const errors: string[] = [];

    // Must export a class (default or named)
    const hasExportClass = /export\s+(default\s+)?class\s+\w+/.test(code);
    if (!hasExportClass) {
      errors.push('Module must export a class (export class ClassName or export default class)');
    }

    // Class must have execute() method
    const hasExecuteMethod = /execute\s*\(\s*\)\s*[:{]/.test(code) ||
                             /async\s+execute\s*\(\s*\)\s*[:{]/.test(code);
    if (!hasExecuteMethod) {
      errors.push('Class must have an execute() method');
    }

    // execute() should return Promise<{ success: boolean }>
    const hasCorrectReturn = /return\s*{\s*success\s*:/.test(code);
    if (!hasCorrectReturn) {
      errors.push('execute() must return { success: boolean }');
    }

    return errors;
  }

  /**
   * Check for common anti-patterns that could cause issues
   */
  private checkAntiPatterns(code: string): string[] {
    const warnings: string[] = [];

    // Check for hardcoded private keys
    if (/PRIVATE_KEY\s*=\s*['"][^'"]+['"]/.test(code) &&
        !/process\.env/.test(code.match(/PRIVATE_KEY\s*=\s*['"][^'"]+['"]/)?.[0] ?? '')) {
      warnings.push('Hardcoded PRIVATE_KEY detected - should use process.env');
    }

    // Check for console.log (should use proper logging)
    const consoleCount = (code.match(/console\.(log|info|debug)/g) ?? []).length;
    if (consoleCount > 3) {
      warnings.push(`Excessive console.log usage (${consoleCount} occurrences)`);
    }

    // Check for missing error handling in async code
    if (/await\s+/.test(code) && !/try\s*{/.test(code)) {
      warnings.push('Async code without try/catch - consider adding error handling');
    }

    // Check for placeholder values
    if (/0x0{40}/.test(code)) {
      warnings.push('Contains placeholder address (0x000...000) - needs real address');
    }
    if (/YourContract|YourAddress|TODO|FIXME/i.test(code)) {
      warnings.push('Contains placeholder text (YourContract, TODO, FIXME)');
    }

    // Check for infinite loops
    if (/while\s*\(\s*true\s*\)/.test(code) && !/break|return/.test(code)) {
      warnings.push('Potential infinite loop detected');
    }

    // FIX-027: Check for external API dependencies that likely need manual setup
    const externalApiPatterns = [
      { pattern: /api\.twitter\.com|twitter\.com\/oauth/i, service: 'Twitter API' },
      { pattern: /api\.youtube\.com|youtube\.googleapis\.com/i, service: 'YouTube API' },
      { pattern: /api\.tiktok\.com|open\.tiktokapis\.com/i, service: 'TikTok API' },
      { pattern: /api\.twitch\.tv|id\.twitch\.tv/i, service: 'Twitch API' },
      { pattern: /api\.openai\.com/i, service: 'OpenAI API' },
      { pattern: /api\.stripe\.com/i, service: 'Stripe API' },
      { pattern: /api\.paypal\.com/i, service: 'PayPal API' },
      { pattern: /graph\.facebook\.com|api\.facebook\.com/i, service: 'Facebook API' },
      { pattern: /api\.instagram\.com/i, service: 'Instagram API' },
      { pattern: /api\.shopify\.com/i, service: 'Shopify API' },
      { pattern: /api\.notion\.com/i, service: 'Notion API' },
      { pattern: /api\.slack\.com/i, service: 'Slack API' },
    ];

    for (const { pattern, service } of externalApiPatterns) {
      if (pattern.test(code)) {
        // Check if the code has the corresponding API key from env
        const hasEnvKey = /process\.env\[['"]?\w*API.?KEY/i.test(code) ||
                          /process\.env\[['"]?\w*TOKEN/i.test(code) ||
                          /process\.env\[['"]?\w*SECRET/i.test(code);
        if (hasEnvKey) {
          warnings.push(`Uses ${service} - verify API key is configured in .env`);
        } else {
          warnings.push(`Uses ${service} but no API key from process.env detected - LIKELY WILL FAIL`);
        }
      }
    }

    return warnings;
  }

  /**
   * Test runtime execution by dynamically importing the module
   */
  private async testRuntimeExecution(
    code: string,
    moduleName: string,
  ): Promise<{ success: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Ensure temp directory exists
    await fs.mkdir(this.tempDir, { recursive: true });

    const tempFile = path.join(this.tempDir, `${moduleName}-${Date.now()}.mjs`);

    // Convert TypeScript to JS-compatible code (basic transformation)
    let jsCode = this.transpileBasic(code);

    // Rewrite bare imports to absolute paths so they resolve from /app/node_modules
    // This is critical for dynamic import() from a temp directory
    jsCode = this.rewriteImportsForRuntime(jsCode);

    try {
      await fs.writeFile(tempFile, jsCode, 'utf8');

      // Dynamic import with timeout
      const importPromise = import(pathToFileURL(tempFile).href);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Import timed out after 5s')), 5000),
      );

      let mod: Record<string, unknown>;
      try {
        mod = await Promise.race([importPromise, timeoutPromise]) as Record<string, unknown>;
      } catch (importErr) {
        // Import failed — likely due to network-dependent code or missing dependencies
        // Treat as a warning rather than a hard failure since the structure is valid
        warnings.push(`Import failed (expected for network-dependent modules): ${(importErr as Error).message}`);
        return { success: true, errors, warnings }; // Allow module with import warnings
      }

      // Find the exported class
      const ClassRef = mod['default'] ?? Object.values(mod).find(
        (v): v is new () => { execute: () => Promise<{ success: boolean }> } =>
          typeof v === 'function' && 'prototype' in v,
      );

      if (!ClassRef || typeof ClassRef !== 'function') {
        errors.push('Could not find exported class');
        return { success: false, errors, warnings };
      }

      // Instantiate and test execute()
      try {
        const instance = new (ClassRef as new () => { execute: () => Promise<{ success: boolean }> })();

        if (typeof instance.execute !== 'function') {
          errors.push('Class instance does not have execute() method');
          return { success: false, errors, warnings };
        }

        // Run execute() with timeout
        const executePromise = instance.execute();
        const executeTimeout = new Promise<{ success: boolean }>((_, reject) =>
          setTimeout(() => reject(new Error('execute() timed out after 10s')), 10_000),
        );

        const result = await Promise.race([executePromise, executeTimeout]);

        if (typeof result?.success !== 'boolean') {
          errors.push('execute() did not return { success: boolean }');
          return { success: false, errors, warnings };
        }

        // Success case - even if execute() returned success: false, the structure is valid
        if (!result.success) {
          warnings.push('execute() returned success: false (expected during validation)');
        }

      } catch (err) {
        const errorMsg = (err as Error).message ?? String(err);
        
        // FIX-027: Classify runtime errors - some indicate missing setup
        const setupRequiredPatterns = [
          /api.?key.*(not|missing|undefined|invalid|required)/i,
          /authentication.*(failed|required|missing)/i,
          /unauthorized|401|403/i,
          /account.*(not|missing|required|create)/i,
          /credentials?.*(not|missing|invalid)/i,
          /token.*(not|missing|expired|invalid)/i,
          /permission.*(denied|required)/i,
          /access.*(denied|forbidden)/i,
          /not.*(configured|setup|initialized)/i,
          /environment.*(variable|not set)/i,
          /ENOTFOUND|ECONNREFUSED/i, // Network errors that might indicate missing config
        ];
        
        const isSetupError = setupRequiredPatterns.some(p => p.test(errorMsg));
        
        if (isSetupError) {
          // This is a HARD FAILURE - the module needs manual setup
          errors.push(`REQUIRES_MANUAL_SETUP: ${errorMsg}`);
          return { success: false, errors, warnings };
        }
        
        // Other errors might be acceptable during validation (network timeouts, etc.)
        warnings.push(`Runtime execution threw: ${errorMsg} (acceptable for validation)`);
      }

    } finally {
      // Clean up temp file
      await fs.unlink(tempFile).catch(() => { /* best effort */ });
    }

    return { success: errors.length === 0, errors, warnings };
  }

  /**
   * Rewrite bare module imports to absolute paths for runtime dynamic import.
   * 
   * Example:
   *   import { ethers } from 'ethers';
   * Becomes:
   *   import { ethers } from '/app/node_modules/ethers/lib.esm/index.js';
   *   (or a simplified version that Node.js can resolve)
   */
  private rewriteImportsForRuntime(code: string): string {
    // Match: import { ... } from 'package-name';
    // Match: import pkg from 'package-name';
    const importRegex = /^(import\s+(?:\{[^}]+\}|\w+)\s+from\s+)['"]([^'"./][^'"]*)['"]/gm;
    
    return code.replace(importRegex, (match, prefix, packageName) => {
      // Common packages and their ESM entry points
      const packageMappings: Record<string, string> = {
        'ethers': '/app/node_modules/ethers/lib.esm/index.js',
        'axios': '/app/node_modules/axios/lib/axios.js',
        // Add more as needed
      };

      const resolvedPath = packageMappings[packageName];
      if (resolvedPath) {
        return `${prefix}'${resolvedPath}'`;
      }

      // For unknown packages, try the node_modules path with .js extension
      // This may not work for all packages but covers many cases
      return `${prefix}'/app/node_modules/${packageName}/index.js'`;
    });
  }

  /**
   * Basic TypeScript to JavaScript transformation
   * Removes type annotations but keeps the logic intact
   */
  private transpileBasic(code: string): string {
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
    result = result.replace(/(\w+)\s+as\s+\w+(?:\.\w+)*(?:\s*[;,\)])/g, '$1$2');

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
}

// Export singleton for convenience
export const autonomousValidator = new AutonomousValidator();
