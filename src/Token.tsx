import './App.scss'
import { Signer, providers, BigNumber } from 'ethers'
import { getAddress, hexDataSlice } from 'ethers/lib/utils'
import React, { Component, ReactNode } from 'react'
import ClipLoader from 'react-spinners/ClipLoader'
import { TokenData } from './interfaces'
import { compareBN, addressToAppName, shortenAddress, getDappListName, getExplorerUrl, lookupEnsName } from './util'
import { Button, Form, InputGroup, OverlayTrigger, Tooltip } from 'react-bootstrap'
import { ENGINE_METHOD_DIGESTS } from 'constants'

type TokenProps = {
  provider: providers.Provider
  chainId: number
  signer?: Signer
  token: TokenData
  signerAddress: string
  inputAddress: string
}

type Allowance = {
  owner: string
  ensOwner?: string
  ownerAppName?: string
  allowance: string
  newAllowance: string
  currentOwnerBalance: string
  tokensAtRisk: string
}

type TokenState = {
  allowances: Allowance[]
  icon?: string
  loading: boolean
  totalTokensAtRisk: string,
}

class Token extends Component<TokenProps, TokenState> {
  state: TokenState = {
    allowances: [],
    loading: true,
    totalTokensAtRisk: '0',
  }

  componentDidMount() {
    this.loadData()
  }

  componentDidUpdate(prevProps: TokenProps) {
    if (this.props.inputAddress === prevProps.inputAddress) return
    this.loadData()
  }

  private async loadData() {
    if (!this.props.token) return
    if (!this.props.inputAddress) return

    const { token } = this.props

    // Filter out duplicate owners
    const approvals = token.approvals
      .filter((approval, i) => i === token.approvals.findIndex(other => approval.topics[1] === other.topics[1]))

    // console.log("approvals", approvals, token)

    // Retrieve current allowance for these Approval events
    let allowances: Allowance[] = (await Promise.all(approvals.map(async (ev) => {
      const owner = getAddress(hexDataSlice(ev.topics[1], 12))
      const allowance = (await token.contract.functions.allowance(owner, this.props.inputAddress)).toString()

      // Filter (almost) zero-value allowances early to save bandwidth
      if (this.formatAllowance(allowance) === '0.000') return undefined

      // Retrieve the owner's ENS name if it exists
      const ensOwner = await await lookupEnsName(owner, this.props.provider)

      // Retrieve the owner's app name if it exists
      const dappListNetworkName = getDappListName(this.props.chainId)
      // const ownerAppName = await addressToAppName(owner, dappListNetworkName)
      //in most cases it just returns an error
      const ownerAppName = null;

      const newAllowance = '0'
      const currentOwnerBalance = (await token.contract.functions.balanceOf(owner)).toString()
      const tokensAtRisk = BigNumber.from(allowance).gte(BigNumber.from(currentOwnerBalance)) ? currentOwnerBalance : allowance
      this.state.totalTokensAtRisk = (BigNumber.from(this.state.totalTokensAtRisk).add(BigNumber.from(tokensAtRisk))).toString()


      return { owner, ensOwner, ownerAppName, allowance, newAllowance, currentOwnerBalance, tokensAtRisk }
    })))

    // Filter out zero-value allowances and sort from h0xF740B67dA229f2f10bcBd38A7979992fCC71B8Ebigh to low
    allowances = allowances
      .filter(allowance => allowance !== undefined)
      .sort((a, b) => -1 * compareBN(a.allowance, b.allowance))

    this.setState({ allowances, loading: false })
  }

  private async revoke(allowance: Allowance) {
    this.update({ ...allowance, newAllowance: '0' })
  }

  private async update(allowance: Allowance) {
    if (!this.props.token) return

    const bnNew = BigNumber.from(this.fromFloat(allowance.newAllowance))
    const bnOld = BigNumber.from(allowance.allowance)
    const { contract } = this.props.token

    let tx

    // Not all ERC20 contracts allow for simple changes in approval to be made
    // https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
    // So we have to do a few try-catch statements
    // First try calling approve directly, then try increase/decreaseApproval,
    // finally try resetting allowance to 0 and then calling approve with new value
    try {
      console.debug(`Calling contract.approve(${allowance.owner}, ${bnNew.toString()})`)
      tx = await contract.functions.approve(allowance.owner, bnNew)
    } catch (e1) {
      console.debug(`failed, code ${e1.code}`)
      if (e1.code === -32000) {
        try {
          const sub = bnOld.sub(bnNew)
          if (sub.gte(0)) {
            console.debug(`Calling contract.decreaseApproval(${allowance.owner}, ${sub.toString()})`)
            tx = await contract.functions.decreaseApproval(allowance.owner, sub)
          } else {
            console.debug(`Calling contract.increaseApproval(${allowance.owner}, ${sub.abs().toString()})`)
            tx = await contract.functions.increaseApproval(allowance.owner, sub.abs())
          }
        } catch (e2) {
          console.debug(`failed, code ${e2.code}`)
          if (e2.code === -32000) {
            console.debug(`Calling contract.approve(${allowance.owner}, 0)`)
            tx = await contract.functions.approve(allowance.owner, 0)
            console.debug(`Calling contract.approve(${allowance.owner}, ${bnNew.toString()})`)
            tx = await contract.functions.approve(allowance.owner, bnNew)
          }
        }
      }
    }

    if (tx) {
      await tx.wait(1)

      console.debug('Reloading data')

      const allowances = this.state.allowances.filter(otherAllowance => otherAllowance.owner !== allowance.owner)
      this.setState({ allowances })
    }
  }

  private toFloat(n: number): string {
    return (n / (10 ** this.props.token.decimals)).toFixed(3)
  }

  private fromFloat(s: string): string {
    const { decimals } = this.props.token

    const sides = s.split('.')
    if (sides.length === 1) return s.padEnd(decimals + s.length, '0')
    if (sides.length > 2) return '0'

    return sides[1].length > decimals
      ? sides[0] + sides[1].slice(0, decimals)
      : sides[0] + sides[1].padEnd(decimals, '0')
  }

  private formatAllowance(allowance: string) {
    const allowanceBN = BigNumber.from(allowance)
    const totalSupplyBN = BigNumber.from(this.props.token.totalSupply)

    if (allowanceBN.gt(totalSupplyBN)) {
      return 'Unlimited'
    }

    return this.toFloat(Number(allowanceBN))
  }

  render(): ReactNode {
    // Do not render tokens without balance or allowances
    const balanceString = this.toFloat(Number(this.props.token.balance))
    if (balanceString === '0.000' && this.state.allowances.length === 0) return null

    return (<div className="Token">{this.renderTokenOrLoading()}</div>)
  }

  renderTokenOrLoading() {
    if (this.state.loading) {
      return (<ClipLoader size={20} color={'#000'} loading={this.state.loading} />)
    }

    return this.renderToken()
  }

  renderToken() {
    return (
      <div>
        {this.renderTokenBalance()}
        <div className="AllowanceList">{this.renderAllowanceList()}</div>
      </div>
    )
  }

  renderTokenBalance() {
    const { symbol, balance } = this.props.token

    const backupImage = (ev) => { (ev.target as HTMLImageElement).src = 'erc20.png' }
    const img = (<img src={this.props.token.icon} alt="" width="20px" onError={backupImage} />)

    // return (<div className="TokenBalance my-auto">{img} {symbol}: {this.toFloat(Number(balance))}</div>)

    return (<div className="TokenBalance my-auto">{img} {symbol}: {this.formatAllowance(this.state.totalTokensAtRisk)}</div>)
  }

  renderAllowanceList() {
    if (this.state.allowances.length === 0) return (<div className="Allowance">No allowances</div>)

    const allowances = this.state.allowances.map((allowance, i) => this.renderAllowance(allowance, i))
    return allowances
  }

  renderAllowance(allowance: Allowance, i: number) {
    return (
      <Form inline className="Allowance" key={allowance.owner}>
        {this.renderAllowanceText(allowance)}
        {/* {this.renderRevokeButton(allowance)}
        {this.renderUpdateInputGroup(allowance, i)} */}
      </Form>
    )
  }

  renderAllowanceText(allowance: Allowance) {
    const owner = allowance.ownerAppName || allowance.ensOwner || allowance.owner
    const shortenedOwner = allowance.ownerAppName || allowance.ensOwner || shortenAddress(allowance.owner)

    const explorerBaseUrl = getExplorerUrl(this.props.chainId)

    const shortenedLink = explorerBaseUrl
      ? (<a className="monospace" href={`${explorerBaseUrl}/${allowance.owner}`}>{shortenedOwner}</a>)
      : shortenedOwner

    const regularLink = explorerBaseUrl
      ? (<a className="monospace" href={`${explorerBaseUrl}/${allowance.owner}`}>{owner}</a>)
      : owner

    // Display separate spans for the regular and shortened versions of the owner address
    // The correct one is selected using CSS media-queries
    return (
      <Form.Label className="AllowanceText">
        <span className="AllowanceTextSmallScreen">
          {this.formatAllowance(allowance.allowance)} allowance from&nbsp;{shortenedLink}
        </span>

        <span className="AllowanceTextBigScreen">
          {this.formatAllowance(allowance.allowance)} allowance from&nbsp;{regularLink}
        </span>

        <span>&nbsp;current balance: {this.formatAllowance(allowance.currentOwnerBalance)}</span>
      </Form.Label>
    )
  }

  renderRevokeButton(allowance: Allowance) {
    const canRevoke = this.props.inputAddress === this.props.signerAddress

    let revokeButton = (<Button
      size="sm" disabled={!canRevoke}
      className="RevokeButton"
      onClick={() => this.revoke(allowance)}
    >Revoke</Button>)

    // Add tooltip if the button is disabled
    if (!canRevoke) {
      const tooltip = (<Tooltip id={`revoke-tooltip-${this.props.token.contract.address}`}>You can only revoke allowances of the connected account</Tooltip>)
      revokeButton = (<OverlayTrigger overlay={tooltip}><span>{revokeButton}</span></OverlayTrigger>)
    }

    return revokeButton
  }

  renderUpdateInputGroup(allowance: Allowance, i: number) {
    const canUpdate = this.props.inputAddress === this.props.signerAddress

    let updateGroup = (<InputGroup size="sm">
      <Form.Control type="text" size="sm"
        className="NewAllowance"
        value={this.state.allowances[i].newAllowance}
        onChange={(event) => {
          const updatedAllowances = this.state.allowances.slice()
          updatedAllowances[i] = { ...allowance, newAllowance: event.target.value }
          this.setState({ allowances: updatedAllowances })
        }} />
      <InputGroup.Append>
        <Button disabled={!canUpdate} className="UpdateButton" onClick={() => this.update(allowance)}>Update</Button>
      </InputGroup.Append>
    </InputGroup>)

    // Add tooltip if the button is disabled
    if (!canUpdate) {
      const tooltip = (<Tooltip id={`update-tooltip-${this.props.token.contract.address}`}>You can only update allowances of the connected account</Tooltip>)
      updateGroup = (<OverlayTrigger overlay={tooltip}><span>{updateGroup}</span></OverlayTrigger>)
    }

    return updateGroup
  }
}

export default Token
