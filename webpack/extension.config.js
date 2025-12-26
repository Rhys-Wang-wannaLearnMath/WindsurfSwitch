const path = require('path');
const webpack = require('webpack');

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';
    
    const plugins = [
        new webpack.DefinePlugin({
            'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development')
        })
    ];
    
    // 混淆将在构建后通过 javascript-obfuscator CLI 完成
    
    return {
        target: 'node',
        mode: isProduction ? 'production' : 'development',
        entry: './src/extension.ts',
        output: {
            path: path.resolve(__dirname, '..', 'dist'),
            filename: 'extension.js',
            libraryTarget: 'commonjs2',
            clean: true
        },
        externals: {
            vscode: 'commonjs vscode'
        },
        resolve: {
            extensions: ['.ts', '.js']
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
                                configFile: path.resolve(__dirname, '..', 'tsconfig.json')
                            }
                        }
                    ]
                }
            ]
        },
        plugins: plugins,
        devtool: isProduction ? false : 'source-map',
        optimization: {
            minimize: isProduction
        }
    };
};
