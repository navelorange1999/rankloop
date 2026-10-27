module.exports = {
  ci: {
    collect: {
      url: [
        'http://127.0.0.1:3000/',
        'http://127.0.0.1:3000/technical/seo-fixture',
        'http://127.0.0.1:3000/zh-CN/trading/market-fixture',
      ],
      numberOfRuns: 1,
      settings: {
        chromeFlags: '--no-sandbox --disable-dev-shm-usage',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
    },
    assert: {
      assertions: {
        'categories:seo': ['error', { minScore: 0.9 }],
        'categories:performance': ['warn', { minScore: 0.6 }],
        'categories:accessibility': ['warn', { minScore: 0.9 }],
      },
    },
    upload: { target: 'filesystem', outputDir: 'artifacts/lighthouse' },
  },
};
