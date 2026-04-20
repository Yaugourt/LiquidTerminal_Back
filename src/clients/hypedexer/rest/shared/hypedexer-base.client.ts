import { BaseApiService } from '../../../../core/base.api.service';
import { unwrapHypeDexerApiPayload } from '../../../../utils/hypedexer-api-response.util';

export abstract class HypeDexerBaseClient extends BaseApiService {
  protected async getUnwrapped<T>(endpoint: string): Promise<T> {
    const raw = await this.get<unknown>(endpoint);
    return unwrapHypeDexerApiPayload(raw) as T;
  }

  protected async getSingleAttemptUnwrapped<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    const raw = await this.getSingleAttempt<unknown>(endpoint, timeoutMs);
    return unwrapHypeDexerApiPayload(raw) as T;
  }
}
