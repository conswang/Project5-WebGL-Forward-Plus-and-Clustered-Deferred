const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MinifyPlugin = require('terser-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = function(env, argv) {
  const isProduction = argv.mode && argv.mode === 'production';

  return {
    context: __dirname,
    entry: path.join(__dirname, 'src/init'),
    output: {
      path: path.join(__dirname, 'docs'),
      filename: 'bundle.js',
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /(node_modules|bower_components)/,
          use: {
              loader: 'babel-loader',
              options: {
                  presets: [['@babel/preset-env', {
                      targets: {
                          browsers: ['> 1%', 'last 2 major versions'],
                      },
                      loose: true,
                      modules: false,
                  }]],
              }
          },
        },
        {
          test: /\.ts?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.glsl$/,
          use: 'webpack-glsl-loader'
        },
      ],
    },
    plugins: [
      isProduction ? new MinifyPlugin({
        terserOptions: {
          keep_fnames: true,
          keep_classnames: true,
        }
      }) : undefined,
      new webpack.DefinePlugin({
        'process.env': {
          'NODE_ENV':  (isProduction ? JSON.stringify('production'): JSON.stringify('development')),
        }
      }),
      new HtmlWebpackPlugin({
        template: "./index.html"
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'models', to: 'models' }
        ]
      }),
    ].filter(p => p),
    performance: {
        hints: false,
        maxEntrypointSize:2048000,
        maxAssetSize: 2048000
    },
    devtool: 'source-map',
    devServer: {
      port: 5650,
      static: {
        directory: path.join(__dirname, 'models'),
        publicPath: '/models',
      },
    },
    resolve: {
      extensions: ['.ts', '.js'],
    }
  };
};
