import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const compat = new FlatCompat({ baseDirectory: __dirname })

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          paths: [
            {
              name: '@/api',
              message: '请从域文件导入，例如 @/api/research/greeksIv',
            },
          ],
          patterns: [
            {
              group: ['**/api/index'],
              message: '请从域文件导入，例如 @/api/research/greeksIv',
            },
          ],
        },
      ],
    },
  },
  {
    // api.ts and api/index.ts are the backward-compat re-export barrels — exempt from the rule
    files: ['src/api.ts', 'src/api/index.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
]
