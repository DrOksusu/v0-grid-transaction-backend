import { BaseAgent } from './base-agent';

interface TestAgentConfig {
  ticker: string;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  orderAmount: number;
  /** 시뮬레이션할 과거 가격 데이터 */
  priceData: number[];
}

interface SimulationResult {
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  totalProfit: number;
  profitPercent: number;
  maxDrawdown: number;
  totalInvested: number;
  finalValue: number;
}

export class TestAgent extends BaseAgent {
  private config: TestAgentConfig | null = null;
  private priceIndex: number = 0;
  private result: SimulationResult | null = null;

  // 시뮬레이션 상태
  private gridLevels: Array<{ price: number; status: 'available' | 'filled'; buyPrice?: number }> = [];
  private totalInvested: number = 0;
  private totalProfit: number = 0;
  private totalBuys: number = 0;
  private totalSells: number = 0;
  private peakValue: number = 0;
  private maxDrawdown: number = 0;

  constructor() {
    super({
      id: 'test',
      name: 'TestAgent',
      description: '그리드 매매 백테스팅/시뮬레이션 에이전트',
      cycleIntervalMs: 0, // 수동으로 runSimulation() 호출
    });
  }

  /** 시뮬레이션 설정 */
  configure(config: TestAgentConfig): void {
    this.config = config;
    this.resetState();
  }

  protected async onStart(): Promise<void> {
    if (!this.config) {
      throw new Error('TestAgent: configure()를 먼저 호출하세요');
    }
    if (this.config.priceData.length === 0) {
      throw new Error('TestAgent: priceData가 비어있습니다');
    }

    this.resetState();
    this.initGridLevels();
  }

  protected async onStop(): Promise<void> {
    this.result = this.buildResult();
  }

  protected async onCycle(): Promise<void> {
    // 수동 실행 전용 - startCycleLoop에서 호출되지 않음
  }

  /** 전체 시뮬레이션 실행 (동기) */
  async runSimulation(): Promise<SimulationResult> {
    if (!this.config) {
      throw new Error('TestAgent: configure()를 먼저 호출하세요');
    }

    await this.start();

    for (let i = 0; i < this.config.priceData.length; i++) {
      this.priceIndex = i;
      const currentPrice = this.config.priceData[i];
      this.processPrice(currentPrice);
      this.metrics.cycles++;
      this.metrics.lastCycleAt = new Date();
    }

    await this.stop();
    return this.result!;
  }

  private resetState(): void {
    this.priceIndex = 0;
    this.result = null;
    this.gridLevels = [];
    this.totalInvested = 0;
    this.totalProfit = 0;
    this.totalBuys = 0;
    this.totalSells = 0;
    this.peakValue = 0;
    this.maxDrawdown = 0;
  }

  private initGridLevels(): void {
    if (!this.config) return;

    const { lowerPrice, upperPrice, gridCount } = this.config;
    const step = (upperPrice - lowerPrice) / gridCount;

    this.gridLevels = [];
    for (let i = 0; i <= gridCount; i++) {
      this.gridLevels.push({
        price: lowerPrice + step * i,
        status: 'available',
      });
    }
  }

  private processPrice(currentPrice: number): void {
    if (!this.config) return;

    // 매수 체크: available 그리드 중 현재가 이하
    for (const grid of this.gridLevels) {
      if (grid.status === 'available' && currentPrice <= grid.price) {
        grid.status = 'filled';
        grid.buyPrice = currentPrice;
        this.totalInvested += this.config.orderAmount;
        this.totalBuys++;
      }
    }

    // 매도 체크: filled 그리드 중 한 단계 위 가격 이상
    for (let i = 0; i < this.gridLevels.length - 1; i++) {
      const grid = this.gridLevels[i];
      const nextGrid = this.gridLevels[i + 1];

      if (grid.status === 'filled' && currentPrice >= nextGrid.price) {
        const buyAmount = this.config.orderAmount;
        const quantity = buyAmount / grid.buyPrice!;
        const sellAmount = quantity * currentPrice;
        this.totalProfit += sellAmount - buyAmount;
        this.totalSells++;

        grid.status = 'available';
        grid.buyPrice = undefined;
      }
    }

    // 최대 낙폭(drawdown) 계산
    const filledValue = this.gridLevels
      .filter(g => g.status === 'filled')
      .reduce((sum, g) => sum + (this.config!.orderAmount / g.buyPrice!) * currentPrice, 0);

    const currentValue = filledValue + this.totalProfit;
    if (currentValue > this.peakValue) {
      this.peakValue = currentValue;
    }
    if (this.peakValue > 0) {
      const drawdown = (this.peakValue - currentValue) / this.peakValue;
      if (drawdown > this.maxDrawdown) {
        this.maxDrawdown = drawdown;
      }
    }
  }

  private buildResult(): SimulationResult {
    const lastPrice = this.config?.priceData[this.config.priceData.length - 1] || 0;

    const filledValue = this.gridLevels
      .filter(g => g.status === 'filled')
      .reduce((sum, g) => sum + (this.config!.orderAmount / g.buyPrice!) * lastPrice, 0);

    const finalValue = filledValue + this.totalProfit;
    const profitPercent = this.totalInvested > 0
      ? (this.totalProfit / this.totalInvested) * 100
      : 0;

    return {
      totalTrades: this.totalBuys + this.totalSells,
      buyTrades: this.totalBuys,
      sellTrades: this.totalSells,
      totalProfit: Math.round(this.totalProfit),
      profitPercent: Math.round(profitPercent * 100) / 100,
      maxDrawdown: Math.round(this.maxDrawdown * 10000) / 100, // %
      totalInvested: Math.round(this.totalInvested),
      finalValue: Math.round(finalValue),
    };
  }

  protected getExtraInfo(): Record<string, any> {
    return {
      config: this.config ? {
        ticker: this.config.ticker,
        lowerPrice: this.config.lowerPrice,
        upperPrice: this.config.upperPrice,
        gridCount: this.config.gridCount,
        priceDataLength: this.config.priceData.length,
      } : null,
      progress: this.config ? `${this.priceIndex}/${this.config.priceData.length}` : null,
      result: this.result,
    };
  }
}
