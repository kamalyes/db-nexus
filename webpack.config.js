const path = require('path')

module.exports = {
  target: 'node',
  mode: 'production',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    clean: true
  },
  externals: {
    vscode: 'commonjs vscode',
    'duckdb': 'commonjs duckdb',
    '@mapbox/node-pre-gyp': 'commonjs @mapbox/node-pre-gyp',
    'node-gyp': 'commonjs node-gyp',
    'aws-sdk': 'commonjs aws-sdk',
    'mock-aws-s3': 'commonjs mock-aws-s3',
    'nock': 'commonjs nock',
    'bluebird': 'commonjs bluebird'
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              compilerOptions: {
                declaration: false,
                declarationMap: false
              }
            }
          }
        ]
      }
    ]
  },
  optimization: {
    minimize: false
  },
  devtool: 'nosources-source-map'
}
