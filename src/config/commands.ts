import packageJson from '../../package.json';

interface ContributedCommand {
  command: string;
  title: string;
  category?: string;
}

export const CONTRIBUTED_COMMANDS = (packageJson.contributes.commands as ContributedCommand[]).map(
  (command) => ({
    id: command.command,
    title: command.title,
    category: command.category ?? 'Pi RPC',
  })
);

export const COMMAND_IDS = CONTRIBUTED_COMMANDS.map((command) => command.id);
