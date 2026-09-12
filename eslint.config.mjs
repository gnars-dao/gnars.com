import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import prettierConfig from "eslint-config-prettier/flat";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      ".worktrees/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "references/**",
      "subgraphs/**",
      "scripts/**",
      ".design-sync/**",
      ".ds-sync/**",
    ],
  },
  {
    // React Compiler rules shipped with eslint-plugin-react-hooks v7 (bundled with
    // Next.js 16). Correctness-critical rules stay as errors. `set-state-in-effect`
    // is disabled because it fires on the standard "fetch-in-effect → setState"
    // pattern that React docs explicitly permit for external-system sync; enforcing
    // it would require rewriting 30+ components without clear correctness win.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/error-boundaries": "error",
      "react-hooks/immutability": "error",
      "react-hooks/purity": "error",
      "react-hooks/refs": "error",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/incompatible-library": "error",
    },
  },
  {
    // Every transaction this app sends carries the Base Builder Code, which is
    // what earns the DAO attribution. That only holds if writes go through the
    // wrappers in `@/lib/builder-code` — importing thirdweb's originals silently
    // drops the suffix, and nothing fails loudly when it happens.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/builder-code.ts",
      "src/lib/builder-code.test.ts",
      // The bench deliberately sends tagged and untagged transactions to compare.
      // Globbed rather than spelled out: the `[locale]` segment would be read as
      // a character class.
      "**/debug/builder-code/page.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "thirdweb",
              importNames: ["prepareContractCall", "prepareTransaction"],
              message:
                "Import prepareContractCall/prepareTransaction from '@/lib/builder-code' so the transaction carries the Base Builder Code.",
            },
          ],
        },
      ],
    },
  },
  {
    // `bag-engine.ts` is a deliberately faithful port of the migrate bag's
    // `_bagcore.js` prototype: it is the canonical copy of physics that was
    // tuned frame-by-frame against that artboard, and it is diffed against it
    // when the artboard changes. Rewriting its `var`s to let/const and its
    // `var self = this` aliases to arrow functions would make every future
    // diff against the prototype unreadable for no behavioural gain, so the
    // two stylistic rules that fire on the ported body are scoped off here
    // rather than the file being rewritten. Nothing else is relaxed.
    files: ["src/components/migrate/bag/bag-engine.ts"],
    rules: {
      "no-var": "off",
      "@typescript-eslint/no-this-alias": "off",
    },
  },
  // Disable rules that conflict with Prettier's formatting
  prettierConfig,
];

export default eslintConfig;
