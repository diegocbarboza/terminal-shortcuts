import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const treeDataProvider = new ButtonTreeDataProvider(context);
    vscode.window.registerTreeDataProvider('buttonView', treeDataProvider);

    const disposable = vscode.commands.registerCommand('extension.handleButtonClick', (command: string, terminalName?: string) => {
        let terminal: vscode.Terminal | undefined; // Store a reference to the terminal

		if (terminalName !== undefined) {
			terminal = getOrCreateTerminal(terminalName as string);
		}
		else {
			terminal = vscode.window.activeTerminal || vscode.window.createTerminal();
		}		
		
        terminal.show();
        terminal.sendText(command);				
		vscode.window.showInformationMessage(`Running command "${command}" in terminal "${terminal?.name}".`);
    });
    
    const openGlobalConfigCommand = vscode.commands.registerCommand('extension.openGlobalConfigCommand', () => {
        const configPath = treeDataProvider.globalConfigFilePath;
        vscode.workspace.openTextDocument(configPath).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    });

    const openWorkspaceConfigCommand = vscode.commands.registerCommand('extension.openWorkspaceConfigCommand', () => {
        const configPath = treeDataProvider.workspaceConfigFilePath;
        treeDataProvider.ensureConfigFile(configPath, "Workspace", `Workspace ${configPath} file created in the .vscode directory.`);
        vscode.workspace.openTextDocument(configPath).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    });

    context.subscriptions.push(disposable, openGlobalConfigCommand, openWorkspaceConfigCommand);
}

export function deactivate() {}

function getOrCreateTerminal(name: string): vscode.Terminal {
    // Check if a terminal with the specified name exists
    let terminal = vscode.window.terminals.find(t => t.name === name);

    if (!terminal) {
        // Create a new terminal if not found
        terminal = vscode.window.createTerminal(name);
    }

    return terminal;
}

// TreeDataProvider to create buttons dynamically
class ButtonTreeDataProvider implements vscode.TreeDataProvider<ButtonItem | GroupItem | OpenConfigButtonItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ButtonItem | GroupItem | OpenConfigButtonItem | undefined | void> 
        = new vscode.EventEmitter<ButtonItem | GroupItem | OpenConfigButtonItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ButtonItem | GroupItem | OpenConfigButtonItem | undefined | void> 
        = this._onDidChangeTreeData.event;

    public globalConfigFilePath: string;
    public workspaceConfigFilePath: string = "";    
    private globalConfigFileName: string = "terminal-shortcuts-global.json";
    private workspaceConfigFileName: string = "terminal-shortcuts-workspace.json";
    private groups: Map<string, Button[]> = new Map();
    private globalFileWatcher: fs.FSWatcher | null = null;
    private workspaceFileWatcher: fs.FSWatcher | null = null;

    constructor(private context: vscode.ExtensionContext) {
        this.globalConfigFilePath = path.join(context.globalStorageUri.fsPath, this.globalConfigFileName);
        this.ensureConfigFile(this.globalConfigFilePath, "Global", `Global ${this.globalConfigFileName} file created in the settings directory.`);
        this.loadGroupsFromConfigFile(this.globalConfigFilePath);
        
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            this.workspaceConfigFilePath = path.join(workspaceFolder.uri.fsPath, '.vscode', this.workspaceConfigFileName);  
            if (fs.existsSync(this.workspaceConfigFilePath)) {
                this.loadGroupsFromConfigFile(this.workspaceConfigFilePath);
            }
        }
        
        this.setupFileWatcher();
    }

    getTreeItem(element: ButtonItem | GroupItem | OpenConfigButtonItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: GroupItem): Thenable<(ButtonItem | GroupItem | OpenConfigButtonItem)[]> {
        if (!element) {
            // Root level: return "Open Config" button and groups
            const globalConfigButton = new OpenConfigButtonItem('Open global config file...', `Open the global config file (${this.globalConfigFilePath})`,
                'extension.openGlobalConfigCommand', 'Open Global Config');
            const workspaceConfigButton = new OpenConfigButtonItem('Open workspace config file...', `Open the workspace config file (${this.workspaceConfigFilePath})`,
                'extension.openWorkspaceConfigCommand', 'Open Worspace Config');

            const groupItems = Array.from(this.groups.keys()).map(
                groupName => new GroupItem(groupName ?? "Default", this.groups.get(groupName)!)
            );
            return Promise.resolve([globalConfigButton, workspaceConfigButton, new SeparatorItem(), ...groupItems]);
        } else if (element instanceof GroupItem) {
            // Inside a group: return buttons
            return Promise.resolve(
                element.buttons.map(button => {
                    let label: string = button.label;
                    if (button.terminal !== undefined) {
                        label = label + " [" + (button.terminal ?? "default") + "]";
                    }

                    return new ButtonItem(label, button.command, button.terminal);
                })
            );
        } else {
            // No children for the "Open Config" button
            return Promise.resolve([]);
        }
    }

    public ensureConfigFile(filePath: string, group: string, infoMessage: string) {
        if (!fs.existsSync(filePath)) {
            // Create the storage directory if it doesn't exist
            const storageDir = path.dirname(filePath);
            if (!fs.existsSync(storageDir)) {
                fs.mkdirSync(storageDir, { recursive: true });
            }

            // Create a default configuration file
            const defaultConfig = [
                {
                    "label": "Show Python version [edit me]",
                    "command": "python --version",
                    "group": group
                },
                {
                    "label": "Show Node.js version [edit me]",
                    "command": "node --version",
                    "group": group
                }
            ];

            fs.writeFileSync(filePath, JSON.stringify(defaultConfig, null, 4), 'utf-8');
            vscode.window.showInformationMessage(infoMessage);

            this.setupFileWatcher();
        }
    }

    private loadGroupsFromConfigFile(filePath: string) {
        if (fs.existsSync(filePath)) {
            try {
                const data = fs.readFileSync(filePath, 'utf-8');
                const buttons: Button[] = JSON.parse(data);

                // Group buttons by the 'group' field
                buttons.forEach(button => {
                    let group: string = button !== undefined ? button.group as string : "Default";
                    if (!this.groups.has(group)) {
                        this.groups.set(group, []);
                    }
                    this.groups.get(group as string)!.push({ label: button.label, command: button.command, terminal: button.terminal });
                });
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to parse buttons.json: ${error.message}`);
            }
        } else {
            vscode.window.showWarningMessage(`No json file found in config folder (${this.globalConfigFilePath}).`);
        }
    }

    // Reload config and refresh tree view on change
    private refreshList() {
        this.groups.clear();
        this.loadGroupsFromConfigFile(this.globalConfigFilePath);
        this.loadGroupsFromConfigFile(this.workspaceConfigFilePath);
        this._onDidChangeTreeData.fire();
    }

    private setupFileWatcher() {
        if (this.globalFileWatcher) {
            this.globalFileWatcher.close();
        }
        
        if (fs.existsSync(this.globalConfigFilePath)) {
            this.globalFileWatcher = fs.watch(this.globalConfigFilePath, (eventType) => {
                if (eventType === 'change') {
                    this.refreshList();
                }
            });
        }
        

        if (this.workspaceFileWatcher) {            
            this.workspaceFileWatcher.close();
        }

        if (fs.existsSync(this.workspaceConfigFilePath)) {
            this.workspaceFileWatcher = fs.watch(this.workspaceConfigFilePath, (eventType) => {
                if (eventType === 'change') {
                    this.refreshList();
                }
            });
        }
    }

    dispose() {
        if (this.globalFileWatcher) {
            this.globalFileWatcher.close();
        }

        if (this.workspaceFileWatcher) {
            this.workspaceFileWatcher.close();
        }
    }
}

// Group Item class
class GroupItem extends vscode.TreeItem {
    constructor(public readonly label: string, public readonly buttons: Button[]) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.tooltip = `Group: ${label}`;
    }
}

// Button Item class
class ButtonItem extends vscode.TreeItem {
    constructor(label: string, command: string, terminal?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = command;
        this.command = {
            command: 'extension.handleButtonClick',
            title: 'Handle Button Click',
            arguments: [command, terminal]
        };
        this.iconPath = new vscode.ThemeIcon('terminal-view-icon');		
    }
}

// Config Button Item class
class OpenConfigButtonItem extends vscode.TreeItem {
    constructor(label: string, tooltip: string, command: string, title: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.command = {
            command: command,
            title: title
        };
        this.iconPath = new vscode.ThemeIcon('gear'); // Icon for the config button
    }
}

class SeparatorItem extends vscode.TreeItem {
    constructor() {
        super('', vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'separator';
    }
}

class Button {
    label: string;
    command: string;
    terminal?: string;
    group?: string;

    constructor(label: string, command: string, terminal?: string, group?: string) { 
        this.label = label;
        this.command = command;
        this.terminal = terminal;
        this.group = group;
    }
}