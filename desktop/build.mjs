import { copyFile } from 'node:fs/promises'

// The web public directory also holds the Windows download. Bundle only the icon.
await copyFile('../frontend/public/orbit.svg', 'dist/orbit.svg')
