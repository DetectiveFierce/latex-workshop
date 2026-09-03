declare module 'monaco-editor/platform/commands/common/commands.js' {
  export const CommandsRegistry: {
    getCommand(id: string): unknown;
  };
}
