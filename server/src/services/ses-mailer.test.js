import { SendEmailCommand } from '@aws-sdk/client-ses';
import { describe, expect, it } from 'vitest';
import { SesMailer } from './ses-mailer';
/** Minimal fake SES client capturing the last dispatched command. */
class FakeSesClient {
    commands = [];
    async send(command) {
        this.commands.push(command);
        return {};
    }
}
const asSesClient = (fake) => fake;
describe('SesMailer', () => {
    it('dispatches a SendEmailCommand with the configured from-address and message', async () => {
        const fake = new FakeSesClient();
        const mailer = new SesMailer({ client: asSesClient(fake), fromAddress: 'noreply@corp.example' });
        await mailer.send({
            to: 'employee@corp.example',
            subject: 'Verify',
            text: 'plain body',
            html: '<p>html body</p>',
        });
        expect(fake.commands).toHaveLength(1);
        const command = fake.commands[0];
        expect(command).toBeInstanceOf(SendEmailCommand);
        const input = command.input;
        expect(input.Source).toBe('noreply@corp.example');
        expect(input.Destination?.ToAddresses).toEqual(['employee@corp.example']);
        expect(input.Message?.Subject?.Data).toBe('Verify');
        expect(input.Message?.Body?.Text?.Data).toBe('plain body');
        expect(input.Message?.Body?.Html?.Data).toBe('<p>html body</p>');
    });
    it('omits the HTML body when not provided', async () => {
        const fake = new FakeSesClient();
        const mailer = new SesMailer({ client: asSesClient(fake), fromAddress: 'noreply@corp.example' });
        await mailer.send({ to: 'e@corp.example', subject: 'S', text: 'only text' });
        const input = fake.commands[0].input;
        expect(input.Message?.Body?.Text?.Data).toBe('only text');
        expect(input.Message?.Body?.Html).toBeUndefined();
    });
    it('throws when no from-address is configured', async () => {
        const fake = new FakeSesClient();
        const mailer = new SesMailer({ client: asSesClient(fake), fromAddress: undefined });
        await expect(mailer.send({ to: 'e@corp.example', subject: 'S', text: 't' })).rejects.toThrow(/SES_FROM_ADDRESS/);
    });
});
