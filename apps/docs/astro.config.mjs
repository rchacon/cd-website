// @ts-check
import { defineConfig } from 'astro/config';

import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.civicdog.com',
  server: {
    port: 4322
  },
  integrations: [
    starlight({
      title: 'CivicDog',
      description: 'How CivicDog is built: data pipeline, API, AWS infrastructure, and automation.',
      logo: {
        src: './src/assets/civicdog-mark.png',
        alt: 'CivicDog'
      },
      favicon: '/favicon-32.png',
      customCss: ['./src/styles/starlight.css'],
      social: [
        { icon: 'external', label: 'civicdog.com', href: 'https://civicdog.com' },
        { icon: 'github', label: 'GitHub', href: 'https://github.com/rchacon' }
      ],
      editLink: {
        baseUrl: 'https://github.com/rchacon/cd-website/edit/main/apps/docs/'
      },
      sidebar: [
        { label: 'Overview', link: '/' },
        { label: 'Architecture', link: '/architecture/' },
        { label: 'Data Pipeline', link: '/data-pipeline/' },
        { label: 'API', link: '/api/' },
        { label: 'Infrastructure', link: '/infrastructure/' },
        { label: 'CI/CD & Automation', link: '/cicd/' },
        { label: 'WordPress Plugin', link: '/wordpress-plugin/' }
      ]
    })
  ]
});
