import * as vscode from 'vscode';
import { AccountManager } from './services/accountManager';
import { AccountSwitcher } from './services/accountSwitcher';
import { AccountPanelProvider } from './webview/accountPanelProvider';

let accountManager: AccountManager;
let accountSwitcher: AccountSwitcher;

export function activate(context: vscode.ExtensionContext) {
    console.log('Windsurf 无感换号 is now active!');

    // Initialize services
    accountManager = new AccountManager(context);
    accountSwitcher = new AccountSwitcher();
    accountSwitcher.setContext(context);

    // Register webview provider
    const panelProvider = new AccountPanelProvider(
        context.extensionUri,
        accountManager,
        accountSwitcher
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AccountPanelProvider.viewType,
            panelProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('windsurf-SWITCH.refresh', () => {
            panelProvider.refresh();
        }),

        vscode.commands.registerCommand('windsurf-SWITCH.switchNext', async () => {
            const { account, index } = await accountManager.getNextAccount();
            if (account) {
                await accountManager.setCurrentAccountIndex(index);
                await accountSwitcher.switchAccount(account);
            } else {
                vscode.window.showWarningMessage('没有可切换的账号，请先添加账号');
            }
        })
    );
}

export function deactivate() {
    console.log('Windsurf 无感换号 is now deactivated!');
}
