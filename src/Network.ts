import { IHasUpstreamInternal } from './UpstreamClient';
import { UpstreamUser } from './UpstreamUser';
import UpstreamRuntime from './UpstreamRuntime';

export enum UpstreamEndpoint {
  Initialize = 'initialize',
  Rgstr = 'rgstr',
  LogEventBeacon = 'log_event_beacon',
}

type NetworkResponse = Response & {
  data?: Record<string, unknown>;
};

export default class UpstreamNetwork {
  private sdkInternal: IHasUpstreamInternal;

  private readonly retryCodes: Record<number, boolean> = {
    408: true,
    500: true,
    502: true,
    503: true,
    504: true,
    522: true,
    524: true,
    599: true,
  };

  private leakyBucket: Record<string, number>;

  private canUseKeepalive: boolean = false;

  public constructor(sdkInternal: IHasUpstreamInternal) {
    this.sdkInternal = sdkInternal;
    this.leakyBucket = {};
    this.init();
  }

  private init(): void {
    if (!this.sdkInternal.getOptions().getDisableNetworkKeepalive()) {
      try {
        this.canUseKeepalive = 'keepalive' in new Request('');
      } catch (_e) {}
    }
  }

  public fetchValues(
    user: UpstreamUser | null,
    timeout: number,
    resolveCallback: (json: Record<string, any>) => Promise<void>,
    rejectCallback: (e: Error) => void,
    prefetchUsers?: Record<string, UpstreamUser>,
  ): Promise<void> {

    console.log('fetchValues::user', user)

    return this.postWithTimeout(
      UpstreamEndpoint.Initialize,
      {
        user,
        prefetchUsers,
        upstreamMetadata: this.sdkInternal.getUpstreamMetadata(),
      },
      resolveCallback,
      rejectCallback,
      timeout, // timeout for early returns
      3, // retries
    );
  }

  private postWithTimeout(
    endpointName: UpstreamEndpoint,
    body: object,
    resolveCallback: (json: Record<string, any>) => Promise<void>,
    rejectCallback: (e: Error) => void,
    timeout: number = 0,
    retries: number = 0,
    backoff: number = 1000,
  ): Promise<void> {

    console.log('endpoint::', endpointName)
    console.log('body::', body)

    const fetchPromise = this.postToEndpoint(
      endpointName,
      body,
      retries,
      backoff,
    )
      .then((res) => {
        if (res.ok && typeof res.data === 'object') {
          const json = res.data;
          return this.sdkInternal.getErrorBoundary().capture(
            'postWithTimeout',
            async () => {
              resolveCallback(json);
              return Promise.resolve(json);
            },
            () => {
              return Promise.resolve({});
            },
            async () => {
              return this.getErrorData(res);
            },
          );
        } 

        return Promise.reject(
          new Error(
            'Request to ' + endpointName + ' failed with status ' + res.status,
          ),
        );
      })
      .then(() => {
        /* return Promise<void> */
      })
      .catch((e) => {
        if (typeof rejectCallback === 'function') {
          rejectCallback(e);
        }
        return Promise.reject(e);
      });

    if (timeout != 0) {
      const timer = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `The initialization timeout of ${timeout}ms has been hit before the network request has completed.`,
            ),
          );
        }, timeout);
      });
      return Promise.race([fetchPromise, timer]);
    }
    return fetchPromise;
  }

  public async postToEndpoint(
    endpointName: UpstreamEndpoint,
    body: object,
    retries: number = 0,
    backoff: number = 1000,
    useKeepalive: boolean = false,
  ): Promise<NetworkResponse> {

    if (this.sdkInternal.getOptions().getLocalModeEnabled()) {
      return Promise.reject('no network requests in localMode');
    }
    if (typeof fetch !== 'function') {
      // fetch is not defined in this environment, short circuit
      console.log('2- no fetch func, instead::', typeof fetch)
      return Promise.reject('fetch is not defined');
    }

    if (typeof window === 'undefined') {
      console.log('3 -- no window')
      // dont issue requests from the server
      return Promise.reject('window is not defined');
    }
    // Able to post 
    console.log('hasAbilityToPost')
    console.log('endpointname::',endpointName)
    const api = endpointName == UpstreamEndpoint.Initialize
        ? this.sdkInternal.getOptions().getApi()
        : this.sdkInternal.getOptions().getEventLoggingApi();
    const url = api + endpointName;
    const counter = this.leakyBucket[url];
    if (counter != null && counter >= 30) {
      return Promise.reject(
        new Error(
          'Request failed because you are making the same request too frequently.',
        ),
      );
    }

    if (counter == null) {
      this.leakyBucket[url] = 1;
    } else {
      this.leakyBucket[url] = counter + 1;
    }

    let postBody = JSON.stringify(body);

    let shouldEncode =
      endpointName === UpstreamEndpoint.Initialize &&
      UpstreamRuntime.encodeInitializeCall &&
      typeof window?.btoa === 'function';

    if (shouldEncode) {
      try {
        const encoded = window.btoa(postBody).split('').reverse().join('');
        postBody = encoded;
      } catch (_e) {
        shouldEncode = false;
      }
    }

    const params: RequestInit = {
      method: 'POST',
      body: postBody,
      headers: {
        'Content-type': 'application/json; charset=UTF-8',
        'Authorization': `Bearer ${this.sdkInternal.getSDKKey()}`,
        'UPSTREAM-CLIENT-TIME': Date.now() + '',
        'UPSTREAM-ENCODED': shouldEncode ? '1' : '0',
      },
    };

    if (this.canUseKeepalive && useKeepalive) {
      params.keepalive = true;
    }

    return fetch(url, params)
      .then(async (res) => {
        if (res.ok) {
          const text = await res.text();
          const networkResponse = res as NetworkResponse;
          networkResponse.data = JSON.parse(text);
          return networkResponse;
        }
        if (!this.retryCodes[res.status]) {
          retries = 0;
        }
        const errorText = await res.text();
        return Promise.reject(new Error(`${res.status}: ${errorText}`));
      })
      .catch((e) => {
        if (retries > 0) {
          return new Promise<NetworkResponse>((resolve, reject) => {
            setTimeout(() => {
              this.leakyBucket[url] = Math.max(this.leakyBucket[url] - 1, 0);
              this.postToEndpoint(
                endpointName,
                body,
                retries - 1,
                backoff * 2,
                useKeepalive,
              )
                .then(resolve)
                .catch(reject);
            }, backoff);
          });
        }
        return Promise.reject(e);
      })
      .finally(() => {
        this.leakyBucket[url] = Math.max(this.leakyBucket[url] - 1, 0);
      });
  }

  public sendLogBeacon(payload: Record<string, any>): boolean {

    if (this.sdkInternal.getOptions().getLocalModeEnabled()) {
      return true;
    }

    const url = new URL(
      this.sdkInternal.getOptions().getEventLoggingApi() +
        UpstreamEndpoint.LogEventBeacon,
    );

    url.searchParams.append('k', this.sdkInternal.getSDKKey());

    payload.clientTime = Date.now() + '';

    let stringPayload = null;
    try {
      stringPayload = JSON.stringify(payload);
    } catch (_e) {
      return false;
    }
    return navigator.sendBeacon(url.toString(), stringPayload);
  }
  public supportsKeepalive(): boolean {
    return this.canUseKeepalive;
  }

  private async getErrorData(
    res: NetworkResponse,
  ): Promise<Record<string, unknown>> {
    try {
      const headers: Record<string, string> = {};
      (res.headers ?? []).forEach((value, key) => {
        headers[key] = value;
      });
      return {
        headers,
        status: res.status,
        statusText: res.statusText,
        type: res.type,
        url: res.url,
        redirected: res.redirected,
        text: res.data ? JSON.stringify(res.data).slice(-100) : null,
      };
    } catch (_e) {
      return {
        statusText: 'upstream::failed to extract extra data',
      };
    }
  }
}
